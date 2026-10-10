import Anthropic from "@anthropic-ai/sdk";
import type { Bot } from "mineflayer";
import { z } from "zod";
import type { Body } from "../body/body.js";
import { messageTeammate as sendToTeammate, narrate, say } from "../comms.js";
import { config, team, type AskMode } from "../config.js";
import { ActionError, Died, Interrupted, Preempted, errorText } from "../errors.js";
import { log } from "../log.js";
import type { SkillLibrary } from "../skills/library.js";
import type { SurvivalHost } from "../survival/reflexes.js";
import type { Memory } from "../world/memory.js";
import { statusLine } from "../world/perception.js";
import { ASK_GUIDANCE, systemPrompt } from "./prompt.js";
import { type SessionStore, briefingFromTranscripts, closeOpenToolCalls, fingerprint, toolsUsed } from "./session.js";
import type { AgentTool, Executive } from "./tools.js";

type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

const STOP_WORDS = /^(stop|halt|cancel|freeze)\W*$/i;
const NEW_MESSAGE = "Stopped partway because the supervisor sent a new message (below). Whatever this call already did still stands.";

// Models that accept `fallbacks: "default"`, which re-runs a request on another
// model server-side if the safety classifiers decline it.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

// USD per million tokens: input, output, cache read, 5-minute cache write.
const PRICING: Record<string, [number, number, number, number]> = {
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};
// Models whose rates go up 5x on requests with a prompt over this many tokens.
const LONG_PROMPT: Record<string, number> = { "claude-haiku-5-5": 100_000 };

interface Pending {
  text: string;
  /** Whether this message should start a new turn if the agent is idle. */
  wake: boolean;
  /** Whether the supervisor sent it, as opposed to the survival layer. */
  fromSupervisor: boolean;
}

type Plan = { goal: string; steps: { step: string; status: string }[] };

const MARK: Record<string, string> = { done: "[x]", doing: "[>]", todo: "[ ]", blocked: "[!]", skipped: "[-]" };
const VERB: Record<string, string> = { done: "done", doing: "now", todo: "next", blocked: "blocked", skipped: "skipped" };

/**
 * What to tell the supervisor about a plan update: the whole plan when it's new or
 * its steps changed, otherwise just the steps whose status moved, or that it's finished.
 */
function describePlanChange(previous: Plan | null, plan: Plan, note?: string): string | null {
  const sameSteps =
    previous?.goal === plan.goal && previous.steps.length === plan.steps.length && previous.steps.every((s, i) => s.step === plan.steps[i]!.step);
  if (!sameSteps) {
    const steps = plan.steps.map((s, i) => `${i + 1}${MARK[s.status] ?? ""} ${s.step}`).join("  ");
    return [`[plan] ${plan.goal}`, ...(note ? [`[plan] ${note}`] : []), `[plan] ${steps}`].join("\n");
  }
  if (plan.steps.every((s) => s.status === "done" || s.status === "skipped")) return `[plan] Finished: ${plan.goal}${note ? ` (${note})` : ""}`;
  const changes = plan.steps.filter((s, i) => s.status !== previous!.steps[i]!.status).map((s) => `${VERB[s.status] ?? s.status}: ${s.step}`);
  if (note) changes.push(note);
  return changes.length ? `[plan] ${changes.join(" | ")}` : null;
}

export interface AgentDeps {
  bot: Bot;
  body: Body;
  tools: AgentTool[];
  memory: Memory;
  skills: SkillLibrary;
  session: SessionStore;
}

/**
 * The decision-making loop. One long conversation with Claude: each supervisor
 * message or survival need starts (or joins) a turn in which Claude plans, calls
 * tools, and checks results until it replies. The history is append-only, which
 * keeps the prompt cache warm and earlier thinking blocks valid.
 */
export class Agent implements SurvivalHost, Executive {
  private readonly client = new Anthropic();
  private readonly bot: Bot;
  private readonly body: Body;
  private readonly memory: Memory;
  private readonly skills: SkillLibrary;
  private readonly session: SessionStore;
  private tools = new Map<string, AgentTool>();
  private fingerprint = "";
  /** Set when a restored history came from different code: its reasoning blocks no longer verify. */
  private dropStaleThinking = false;
  /** A condensed log of the previous session, delivered with the next message. */
  private briefing: string | null = null;
  private toolDefinitions: Anthropic.Beta.BetaToolUnion[] = [];
  private readonly system: string;
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  private pending: Pending[] = [];
  private systemNotes: string[] = [];
  private abort: AbortController | null = null;
  /** The tool call in progress, so a new message can stop just that call. */
  private currentCall: AbortController | null = null;
  /** A supervisor message arrived mid-turn and Claude hasn't read it yet. */
  private unread = false;
  private asking: ((from: string, answer: string) => void) | null = null;
  private idleSince = Date.now();
  private teammateWakes: number[] = [];
  private teammateWaiter: ((message: string) => void) | null = null;
  private currentPlan: { goal: string; steps: { step: string; status: string }[] } | null = null;
  private totals = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 };

  constructor(deps: Omit<AgentDeps, "tools">) {
    this.bot = deps.bot;
    this.body = deps.body;
    this.memory = deps.memory;
    this.skills = deps.skills;
    this.session = deps.session;
    this.system = systemPrompt(deps.bot.username, config.mc.version, config.askMode);
  }

  /** Tools are created after the agent (some need it as their executive). */
  setTools(tools: AgentTool[]) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
    // Strip the local run/parse functions and flags; the API only needs the definitions.
    this.toolDefinitions = tools.map(({ run, parse, close, body, ...definition }) => definition);
    this.fingerprint = fingerprint(this.system, this.toolDefinitions);
  }

  /** Restores the saved conversation, or prepares a briefing from the last session's log. Returns what happened. */
  restore(): string {
    if (!config.resume) return "Starting a fresh conversation (RESUME_SESSION=off).";
    const saved = this.session.load();
    if (saved) {
      const missing = [...toolsUsed(saved.messages)].filter((name) => !this.tools.has(name));
      if (!missing.length) {
        this.messages = closeOpenToolCalls(saved.messages);
        this.dropStaleThinking = saved.fingerprint !== this.fingerprint;
        return `Resumed the previous conversation (${saved.messages.length} messages, last saved ${saved.savedAt.slice(0, 16).replace("T", " ")} UTC)${
          this.dropStaleThinking ? "; the code changed since then, so reasoning blocks from before won't be replayed" : ""
        }.`;
      }
      log.warn(`The saved conversation used tools that no longer exist (${missing.join(", ")}), so it can't be resumed as is.`);
    }
    this.briefing = briefingFromTranscripts(config.logDir, log.transcriptPath);
    return this.briefing
      ? "No conversation to resume; the agent gets a condensed log of the previous session with its next message."
      : "Starting a fresh conversation.";
  }

  get busy(): boolean {
    return this.abort !== null;
  }

  /**
   * A chat line (or terminal line) from the supervisor. `audience` says who it was
   * addressed to ("you", "your team (red)", "everyone"), so the agent knows whether
   * other agents got it too.
   */
  receive(from: string, text: string, audience = "you") {
    const to = audience === "you" ? "" : `(to ${audience}) `;
    log.incoming(from, `${to}${text}`);
    if (STOP_WORDS.test(text.trim())) {
      this.interrupt();
      this.pending.push({ text: `<${from}> ${to}${text} (you were halted immediately)`, wake: false, fromSupervisor: true });
      return;
    }
    if (this.asking) return this.asking(from, text);
    this.pending.push({ text: `<${from}> ${to}${text}`, wake: true, fromSupervisor: true });
    if (!this.busy) return void this.run();
    // Mid-task: stop the current action so Claude reads this now, not when it's done.
    this.unread = true;
    this.currentCall?.abort(new Interrupted(NEW_MESSAGE));
  }

  /** A message a teammate sent with message_teammate. */
  receiveTeammate(from: string, text: string, expectsReply: boolean) {
    log.incoming(`${from} (teammate)`, text);
    if (this.teammateWaiter) return this.teammateWaiter(`${from}${expectsReply ? " (wants a reply)" : ""}: ${text}`);
    // Requests wake the agent; FYIs wait for its next turn. The cap stops two agents
    // from talking each other into an expensive loop.
    const now = Date.now();
    this.teammateWakes = this.teammateWakes.filter((t) => now - t < 600_000);
    const wake = expectsReply && this.teammateWakes.length < 20;
    if (wake) this.teammateWakes.push(now);
    this.pending.push({ text: `[teammate ${from}${expectsReply ? ", wants a reply" : ""}] ${text}`, wake, fromSupervisor: false });
    if (wake && !this.busy) void this.run();
  }

  /** Switches how readily the agent asks for guidance, effective from its next step. */
  setAskMode(mode: AskMode) {
    config.askMode = mode;
    // A mid-conversation system message, not an edit to the system prompt: that keeps
    // the cached prefix and earlier thinking intact.
    this.systemNotes.push(`${ASK_GUIDANCE[mode]} This replaces any earlier ask mode.`);
    log.info(`Ask mode is now "${mode}".`);
  }

  // ---- SurvivalHost --------------------------------------------------------------

  idleMs(): number {
    return this.busy ? 0 : Date.now() - this.idleSince;
  }

  alert(text: string) {
    log.incoming("survival", text);
    this.pending.push({ text: `[survival] ${text}`, wake: true, fromSupervisor: false });
    if (!this.busy) void this.run();
  }

  /** What a reflex did; Claude reads it with its next message. */
  report(text: string) {
    this.pending.push({ text: `[survival] ${text}`, wake: false, fromSupervisor: false });
  }

  // ---- Executive -------------------------------------------------------------------

  ask(question: string, options: string[] | undefined, signal: AbortSignal): Promise<string> {
    const text = options?.length ? `${question} Options: ${options.map((o, i) => `(${i + 1}) ${o}`).join(" ")}` : question;
    log.question(text);
    say(this.bot, `Question: ${text}`);
    return new Promise((resolve) => {
      const done = (answer: string) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.asking = null;
        resolve(answer);
      };
      const timer = setTimeout(
        () => done(`No answer after ${config.askTimeoutMinutes} minutes. Use your best judgment and say what you assumed.`),
        config.askTimeoutMinutes * 60_000,
      );
      const onAbort = () => done("The question was cancelled.");
      signal.addEventListener("abort", onAbort, { once: true });
      this.asking = (from, answer) => done(`${from} answered: ${answer}`);
    });
  }

  plan(goal: string, steps: { step: string; status: string }[], note?: string) {
    const previous = this.currentPlan;
    this.currentPlan = { goal, steps };
    log.plan(goal, steps);
    if (note) log.info(`Plan note: ${note}`);
    if (config.planInChat) {
      const update = describePlanChange(previous, { goal, steps }, note);
      if (update) narrate(this.bot, update);
    }
  }

  tell(text: string) {
    say(this.bot, text);
  }

  /** Waits for the next teammate message (or returns ones that already arrived). */
  waitForTeammate(seconds: number, signal: AbortSignal): Promise<string> {
    const waiting = this.pending.filter((p) => p.text.startsWith("[teammate "));
    if (waiting.length) {
      this.pending = this.pending.filter((p) => !waiting.includes(p));
      return Promise.resolve(waiting.map((p) => p.text).join("\n"));
    }
    return new Promise((resolve) => {
      const done = (message: string) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.teammateWaiter = null;
        resolve(message);
      };
      const timer = setTimeout(() => done(`No message from your teammates in ${seconds}s.`), seconds * 1000);
      const onAbort = () => done("Stopped waiting (interrupted).");
      signal.addEventListener("abort", onAbort, { once: true });
      this.teammateWaiter = done;
    });
  }

  messageTeammate(to: string, text: string, expectsReply: boolean): string {
    const targets = to.toLowerCase() === "team" ? team.mates : team.mates.filter((m) => m.toLowerCase() === to.toLowerCase());
    if (!targets.length) {
      throw new ActionError("INVALID", team.mates.length ? `${to} isn't on your team. Teammates: ${team.mates.join(", ")}.` : "You have no teammates.");
    }
    const online = targets.filter((name) => this.bot.players[name]);
    if (!online.length) throw new ActionError("NOT_FOUND", `${targets.join(", ")} ${targets.length > 1 ? "aren't" : "isn't"} online right now.`);
    for (const name of online) sendToTeammate(this.bot, name, text, expectsReply);
    log.event(`To ${online.join(", ")}${expectsReply ? " (wants a reply)" : ""}: ${text}`);
    const offline = targets.filter((t) => !online.includes(t));
    return `Sent to ${online.join(", ")}.${offline.length ? ` (${offline.join(", ")} offline.)` : ""}`;
  }

  // ---- Control ----------------------------------------------------------------------

  /** Halts the bot and the current task right away, without waiting for Claude. */
  interrupt() {
    this.abort?.abort();
    this.body.halt();
    say(this.bot, "Stopped.");
  }

  /** Forgets the conversation so the next task starts fresh. Memory and skills persist. */
  reset() {
    if (this.busy) this.interrupt();
    this.messages = [];
    this.pending = [];
    this.systemNotes = [];
    this.currentPlan = null;
    this.briefing = null;
    this.dropStaleThinking = false;
    this.session.clear();
  }

  showPlan() {
    if (this.currentPlan) log.plan(this.currentPlan.goal, this.currentPlan.steps);
    else log.info("No plan yet.");
  }

  /** A read-only snapshot for the dashboard: the current plan, this session's usage, and whether a question is waiting. */
  state() {
    return {
      busy: this.busy,
      asking: this.asking !== null,
      plan: this.currentPlan && { goal: this.currentPlan.goal, steps: this.currentPlan.steps.map((s) => ({ ...s })) },
      usage: { ...this.totals },
    };
  }

  usageSummary(): string {
    const t = this.totals;
    const cost = PRICING[config.claude.model] ? `, ≈$${t.cost.toFixed(2)}` : "";
    return `${t.requests} requests: ${t.input + t.cacheRead + t.cacheWrite} input tokens (${t.cacheRead} cache reads), ${t.output} output tokens${cost}`;
  }

  // ---- The loop -----------------------------------------------------------------------

  private async run() {
    const abort = new AbortController();
    this.abort = abort;
    // Hold on to this run's history: after a /reset, a run that's still unwinding must
    // not append to the fresh conversation.
    const messages = this.messages;
    try {
      let batch = this.takePending(true);
      // Replies go to chat only when the supervisor asked for something.
      let supervisorAsked = batch.fromSupervisor;
      this.pushUser(messages, batch.text);
      while (!abort.signal.aborted) {
        const response = await this.request(messages, abort.signal);
        messages.push({ role: "assistant", content: response.content });
        this.persist(messages);
        this.logResponse(response);

        const toolUses = response.content.filter((b): b is ToolUse => b.type === "tool_use");
        if (response.stop_reason === "tool_use" && toolUses.length) {
          const content: Anthropic.Beta.BetaContentBlockParam[] = await this.runTools(toolUses, abort.signal);
          // Supervisor chat and survival notes that arrived mid-task ride along with the results.
          if (this.pending.length) {
            batch = this.takePending(false);
            supervisorAsked ||= batch.fromSupervisor;
            content.push({ type: "text", text: batch.text });
          }
          this.pushUser(messages, content);
          continue;
        }
        if (response.stop_reason === "pause_turn") continue;

        if (toolUses.length) {
          // A cut-off response can still contain tool calls; every call needs a result.
          this.pushUser(
            messages,
            toolUses.map((call) => ({
              type: "tool_result" as const,
              tool_use_id: call.id,
              is_error: true,
              content: `Not run: the response ended with stop_reason "${response.stop_reason}".`,
            })),
          );
        }
        if (response.stop_reason === "refusal") {
          log.warn(`Request declined (${response.stop_details?.category ?? "no category"}).`);
          if (supervisorAsked) say(this.bot, "Sorry, I can't help with that one.");
        } else if (response.stop_reason === "max_tokens") {
          log.warn("Response hit max_tokens and was cut off.");
        }
        const reply = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (reply && supervisorAsked) say(this.bot, reply);
        else if (reply) log.info(`Claude (not sent to chat): ${reply}`);

        if (!this.pending.some((p) => p.wake)) break;
        batch = this.takePending(true);
        supervisorAsked = batch.fromSupervisor;
        this.pushUser(messages, batch.text);
      }
    } catch (err) {
      if (!abort.signal.aborted) this.reportFailure(err);
    } finally {
      this.abort = null;
      this.idleSince = Date.now();
      if (this.pending.some((p) => p.wake)) void this.run();
    }
  }

  /** Appends a user message, followed by any pending system notes (e.g. an ask-mode change). */
  private pushUser(messages: Anthropic.Beta.BetaMessageParam[], content: string | Anthropic.Beta.BetaContentBlockParam[]) {
    messages.push({ role: "user", content });
    for (const note of this.systemNotes.splice(0)) messages.push({ role: "system", content: note });
    this.persist(messages);
  }

  /** Saves the conversation so a restart can pick it up (unless this run was orphaned by /reset). */
  private persist(messages: Anthropic.Beta.BetaMessageParam[]) {
    if (messages !== this.messages) return;
    try {
      this.session.save(config.claude.model, this.fingerprint, messages);
    } catch (err) {
      log.warn(`Couldn't save the conversation: ${errorText(err)}`);
    }
  }

  private request(messages: Anthropic.Beta.BetaMessageParam[], signal: AbortSignal) {
    const model = config.claude.model;
    const fallbacks = FALLBACK_MODELS.has(model);
    return this.client.beta.messages.create(
      {
        model,
        max_tokens: 16000,
        betas: [
          "compact-2026-01-12",
          ...(fallbacks ? ["server-side-fallback-2026-07-01"] : []),
          ...(this.dropStaleThinking ? ["thinking-binding-controls-2026-08-01"] : []),
        ],
        ...(fallbacks ? { fallbacks: "default" as const } : {}),
        // Summarized thinking lets the supervisor watch the agent's reasoning. After
        // resuming a history made by different code, reasoning blocks from before no
        // longer verify; drop them instead of failing the request.
        thinking: {
          type: "adaptive",
          display: "summarized",
          ...(this.dropStaleThinking ? { block_binding: { prefix_mismatch_behavior: "drop_block" as const } } : {}),
        },
        output_config: { effort: config.claude.effort },
        // Server-side compaction summarizes old history once the conversation gets long.
        context_management: { edits: [{ type: "compact_20260112" }] },
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
        tools: this.toolDefinitions,
        messages,
      },
      { signal },
    );
  }

  private async runTools(calls: ToolUse[], signal: AbortSignal): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    let cutOff: Interrupted | null = null; // a reflex took over, or the bot died
    // One body, one action at a time: run calls in order, never in parallel.
    for (const call of calls) {
      log.toolCall(call.name, call.input);
      const started = Date.now();
      const tool = this.tools.get(call.name);
      let output: string;
      let isError = true;
      if (signal.aborted) {
        output = "Not run: interrupted by the supervisor.";
      } else if (this.unread) {
        output = "Not run: the supervisor sent a new message (below) before this call started. Read it first.";
      } else if (cutOff) {
        const what = cutOff instanceof Died ? "you died during the call before this one" : "your survival reflexes interrupted the call before this one";
        output = `Not run: ${what}. Check your status and decide again.`;
      } else if (!tool) {
        output = `Unknown tool "${call.name}".`;
      } else {
        const stopCall = new AbortController();
        this.currentCall = stopCall;
        const callSignal = AbortSignal.any([signal, stopCall.signal]);
        try {
          if (!tool.body) {
            ({ output, isError } = await this.execute(tool, call, callSignal));
          } else {
            // Waits here while a reflex has the body; a reflex arriving later preempts this lease.
            let lease;
            try {
              lease = await this.body.acquire(`task:${call.name}`, "task", callSignal);
            } catch {
              lease = null;
            }
            if (!lease) {
              output = `Not run: ${callSignal.reason instanceof Interrupted ? callSignal.reason.message : "interrupted by the supervisor."}`;
            } else {
              try {
                if (this.bot.isSleeping && call.name !== "sleep_in_bed") await this.bot.wake().catch(() => {});
                ({ output, isError } = await this.execute(tool, call, lease.signal));
              } finally {
                const reason: unknown = lease.signal.reason;
                if (reason instanceof Preempted || reason instanceof Died) cutOff = reason;
                lease.release();
              }
            }
          }
        } finally {
          this.currentCall = null;
        }
      }
      log.toolResult(call.name, output, isError, Date.now() - started);
      results.push({ type: "tool_result", tool_use_id: call.id, content: output, ...(isError && { is_error: true }) });
    }
    return results;
  }

  /** Runs one tool call to completion. Never throws: failures become error results. */
  private async execute(tool: AgentTool, call: ToolUse, signal: AbortSignal): Promise<{ output: string; isError: boolean }> {
    try {
      const result = await tool.run(tool.parse(call.input), { toolUse: call, toolUseBlock: call, signal });
      return { output: typeof result === "string" ? result : JSON.stringify(result), isError: false };
    } catch (err) {
      if (err instanceof z.ZodError) return { output: `Invalid input: ${z.prettifyError(err)}`, isError: true };
      if (err instanceof ActionError) {
        const details = err.details ? ` ${JSON.stringify(err.details)}` : "";
        return { output: `[${err.code}] ${err.message}${details}`, isError: true };
      }
      if (err instanceof Interrupted) return { output: err.message, isError: true };
      log.error(`${call.name} threw unexpectedly`, err);
      return { output: `[ERROR] ${errorText(err)}`, isError: true };
    }
  }

  private takePending(withHeader: boolean): { text: string; fromSupervisor: boolean } {
    this.unread = false;
    const lines = this.pending.map((p) => p.text);
    const fromSupervisor = this.pending.some((p) => p.fromSupervisor);
    this.pending = [];
    if (withHeader) lines.unshift(...this.header());
    return { text: lines.join("\n"), fromSupervisor };
  }

  /** Status, memory, and skills, prepended to each new turn. */
  private header(): string[] {
    const lines = [`[status] ${statusLine(this.bot)}`];
    const digest = this.memory.digest();
    if (digest) lines.push(`[memory]\n${digest}`);
    const skills = this.skills.list();
    if (skills.length) lines.push(`[skills] ${skills.map((s) => s.name).join(", ")}`);
    if (team.mates.length) {
      lines.push(`[team ${team.name}] ${team.mates.map((name) => `${name} (${this.bot.players[name] ? "online" : "offline"})`).join(", ")}`);
    }
    if (this.briefing) {
      lines.push(this.briefing);
      this.briefing = null;
    }
    return lines;
  }

  private logResponse(response: Anthropic.Beta.BetaMessage) {
    for (const block of response.content) {
      if (block.type === "thinking" && block.thinking.trim()) log.thinking(block.thinking.trim());
      else if (block.type === "fallback") log.warn(`${block.from.model} declined; ${block.to.model} took over.`);
      else if (block.type === "compaction") log.info("Context compacted: older history was summarized.");
    }
    log.raw("response", { id: response.id, model: response.model, stop_reason: response.stop_reason, content: response.content });

    const u = response.usage;
    const input = u.input_tokens;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const output = u.output_tokens;
    const price = PRICING[config.claude.model];
    const tier = input + cacheRead + cacheWrite > (LONG_PROMPT[config.claude.model] ?? Infinity) ? 5 : 1;
    const cost = price ? (tier * (input * price[0] + output * price[1] + cacheRead * price[2] + cacheWrite * price[3])) / 1e6 : 0;
    const t = this.totals;
    t.requests++;
    t.input += input;
    t.cacheRead += cacheRead;
    t.cacheWrite += cacheWrite;
    t.output += output;
    t.cost += cost;
    log.usage(
      `${input + cacheRead + cacheWrite} in (${cacheRead} cached) · ${output} out${price ? ` · ≈$${cost.toFixed(3)} (session ≈$${t.cost.toFixed(2)})` : ""}`,
      { input, cacheRead, cacheWrite, output, cost },
    );
  }

  private reportFailure(err: unknown) {
    let message: string;
    if (err instanceof Anthropic.AuthenticationError) message = "No valid Anthropic credentials. Set ANTHROPIC_API_KEY in .env (or log in with the Anthropic CLI) and restart.";
    else if (err instanceof Anthropic.RateLimitError) message = "Rate limited by the Anthropic API. Wait a bit and try again.";
    else if (err instanceof Anthropic.BadRequestError) message = `The API rejected the request: ${err.message}. If this keeps happening, type /reset in the terminal.`;
    else if (err instanceof Anthropic.APIError) message = `Anthropic API error${err.status ? ` ${err.status}` : ""}: ${err.message}`;
    else message = errorText(err);
    log.error(message, err);
    say(this.bot, "Something went wrong on my end; check the terminal.");
  }
}
