// The dashboard page. Home shows global spend and a card per agent; the agent view
// shows one agent's status and costs, a chat with it, and a live feed of what it's
// thinking and doing. Plain DOM, no framework or build step.
//
// Transcript text (game chat, model output) is untrusted, so it only ever reaches the
// page as text, through el() and textContent, never as HTML.

const $ = (id) => document.getElementById(id);
const PAGE = 500;

/** Creates an element. Strings and numbers become text nodes, never markup. */
function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false || child === "") continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

// ---- Formatting ------------------------------------------------------------------------

function money(usd) {
  const n = Number(usd) || 0;
  return `$${n >= 1 || n === 0 ? n.toFixed(2) : n.toFixed(3)}`;
}

function tokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** Everything sent to the model: fresh input plus cache reads and writes. */
const inputTokens = (u) => (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);

function ago(iso) {
  const ms = Date.parse(iso ?? "");
  if (Number.isNaN(ms)) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function clock(iso) {
  const d = new Date(iso ?? "");
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function timeEl(iso) {
  const node = el("span", "time", clock(iso));
  if (iso) node.title = new Date(iso).toLocaleString();
  return node;
}

/** "session-2026-10-09T20-40-08-228Z.jsonl" -> "Session started Oct 9, 1:40 PM". */
function sessionLabel(file) {
  const m = file.match(/(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d+)Z/);
  if (!m) return `Session ${file}`;
  const start = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return `Session started ${start.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

function firstLine(text, max = 200) {
  const line = String(text ?? "").trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

// ---- Agent status ------------------------------------------------------------------------

function agentState(row) {
  if (!row?.online) return { text: "offline", cls: "offline" };
  if (row.asking) return { text: "has a question for you", cls: "asking" };
  if (row.busy) return { text: "working", cls: "busy" };
  return { text: "idle", cls: "idle" };
}

function dotClass(row) {
  const { cls } = agentState(row);
  return cls === "offline" ? "dot" : `dot online ${cls}`;
}

function describeModel(row) {
  return [row.model, row.effort && `effort ${row.effort}`, row.askMode && `asks ${row.askMode}`].filter(Boolean).join(" · ");
}

const STEP_STATUSES = new Set(["done", "doing", "todo", "blocked", "skipped"]);
const stepClass = (status) => `st st-${STEP_STATUSES.has(status) ? status : "todo"}`;

/** The step being worked on (or blocked, or next), or null if there's no plan. */
function currentStep(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!steps.length) return null;
  for (const wanted of ["doing", "blocked", "todo"]) {
    const i = steps.findIndex((s) => s.status === wanted);
    if (i >= 0) return { text: `${i + 1}/${steps.length} ${steps[i].step}`, status: wanted };
  }
  return { text: "Finished", status: "done" };
}

function bar(value, kind) {
  const fill = el("div", "fill");
  fill.style.width = `${Math.max(0, Math.min(100, (Number(value) / 20) * 100))}%`;
  return el("span", `bar ${kind}${Number(value) <= 6 ? " low" : ""}`, fill);
}

function vitals(live) {
  return el(
    "div",
    "vitals",
    el("span", "vital", "HP", bar(live.health, "health"), `${live.health}/20`),
    el("span", "vital", "Food", bar(live.food, "food"), `${live.food}/20`),
    el("span", null, `${live.phase}${live.raining ? ", raining" : ""}`),
  );
}

function whereabouts(live) {
  const p = live.position ?? {};
  const dimension = String(live.dimension ?? "").replace(/^minecraft:/, "");
  const parts = [`at ${p.x} ${p.y} ${p.z}${dimension && dimension !== "overworld" ? ` (${dimension})` : ""}`];
  parts.push(live.sleeping ? "sleeping" : live.sheltered ? "sheltered" : "in the open");
  parts.push(`holding ${live.holding ?? "nothing"}`);
  const hostiles = Object.entries(live.hostiles ?? {}).map(([name, n]) => `${name} x${n}`);
  if (hostiles.length) parts.push(`hostiles nearby: ${hostiles.join(", ")}`);
  return parts.join(" · ");
}

// ---- Live updates ------------------------------------------------------------------------

function setConnection(live) {
  const node = $("connection");
  node.textContent = live ? "live" : "reconnecting…";
  node.classList.toggle("connected", live);
}

/** Server-Sent Events: overview snapshots every couple of seconds, and new transcript lines. */
function openStream(agent, handlers) {
  const source = new EventSource(agent ? `/api/stream?agent=${encodeURIComponent(agent)}` : "/api/stream");
  let dropped = false;
  source.addEventListener("open", () => {
    setConnection(true);
    if (dropped) handlers.reconnected?.();
    dropped = false;
  });
  source.addEventListener("error", () => {
    setConnection(false);
    dropped = true;
  });
  source.addEventListener("overview", (e) => handlers.overview(JSON.parse(e.data)));
  source.addEventListener("transcript", (e) => handlers.transcript?.(JSON.parse(e.data)));
  return source;
}

function showSection(id) {
  $("home").hidden = id !== "home";
  $("agent").hidden = id !== "agent";
}

// ---- Home --------------------------------------------------------------------------------

const cards = new Map();

function homeView() {
  showSection("home");
  document.title = "agentcraft dashboard";
  const source = openStream(null, { overview: renderHome });
  return { close: () => source.close() };
}

function renderHome(data) {
  const { allTime, today } = data.totals;
  $("cost-all").textContent = money(allTime.cost);
  $("cost-today").textContent = money(today.cost);
  $("today-date").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  $("tok-in").textContent = tokens(inputTokens(allTime));
  $("tok-in").title = `${inputTokens(allTime).toLocaleString()} input tokens`;
  $("tok-cached").textContent = `${tokens(allTime.cacheRead)} from cache · ${tokens(inputTokens(today))} today`;
  $("tok-out").textContent = tokens(allTime.output);
  $("tok-out").title = `${allTime.output.toLocaleString()} output tokens`;
  $("tok-out-today").textContent = `${tokens(today.output)} today`;
  $("tok-req").textContent = allTime.requests.toLocaleString();
  $("tok-req-today").textContent = `${today.requests.toLocaleString()} today`;
  const online = data.agents.filter((a) => a.online).length;
  $("agent-count").textContent = data.agents.length ? `${online} of ${data.agents.length} running` : "";
  $("no-agents").hidden = data.agents.length > 0;

  const wanted = data.agents.map((row) => {
    let card = cards.get(row.name);
    if (!card) cards.set(row.name, (card = el("a", "card")));
    fillCard(card, row);
    return card;
  });
  for (const [name, card] of cards) if (!wanted.includes(card)) cards.delete(name);
  const container = $("cards");
  // Only reorder when the order changed, so hovering a card isn't disturbed.
  if (wanted.length !== container.children.length || wanted.some((card, i) => container.children[i] !== card)) container.replaceChildren(...wanted);
}

function fillCard(card, row) {
  const state = agentState(row);
  const step = currentStep(row.plan);
  card.href = `#/agent/${encodeURIComponent(row.name)}`;
  card.classList.toggle("offline", !row.online);
  const u = row.usage;
  const parts = [
    el("div", "card-head", el("span", dotClass(row)), el("span", "name", row.name), row.team && el("span", "badge", row.team), el("span", `state ${state.cls}`, state.text)),
    el("div", "meta", describeModel(row) || "model unknown"),
    el(
      "div",
      "card-costs",
      el("div", null, el("b", null, money(u.allTime.cost)), el("span", null, "all time")),
      el("div", null, el("b", null, money(u.today.cost)), el("span", null, "today")),
      el("div", null, el("b", null, money(u.session.cost)), el("span", null, row.online ? "this session" : "last session")),
    ),
    step
      ? el("div", "plan-line", el("span", "goal", `${row.online ? "" : "Last plan: "}${row.plan.goal} › `), el("span", stepClass(step.status), step.text))
      : el("div", "plan-line muted", row.online ? "No plan yet" : ""),
    row.online && (row.live ? vitals(row.live) : el("div", "vitals", "Joining the world…")),
    el(
      "div",
      "foot",
      `${u.allTime.requests.toLocaleString()} requests · ${tokens(inputTokens(u.allTime))} in / ${tokens(u.allTime.output)} out · ${
        row.lastActivity ? `active ${ago(row.lastActivity)}` : "no activity yet"
      }`,
    ),
  ];
  card.replaceChildren(...parts.filter(Boolean));
  card.title = row.plan?.goal ?? "";
}

// ---- Rendering transcript events -----------------------------------------------------------

// A message the agent sent a teammate, logged as a game event.
const TEAMMATE_OUT = /^To ([A-Za-z0-9_, ]+?)( \(wants a reply\))?: ([\s\S]*)$/;
// A reply that wasn't sent to game chat (the turn wasn't the supervisor's).
const NOT_SENT = "Claude (not sent to chat): ";

function divider(file) {
  const node = el("div", "divider", sessionLabel(file));
  node.dataset.file = file;
  return node;
}

function clampedText(text, className) {
  const node = el("div", `${className} clamp`, text);
  node.title = "Click to expand or collapse";
  node.addEventListener("click", () => node.classList.toggle("clamp"));
  return node;
}

function pretty(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/**
 * Turns transcript events into chat messages and activity items. It keeps a little
 * state between events: open tool calls waiting for results, the last chat message (a
 * long reply arrives as several chat lines), and the chat copy of a question to skip.
 */
class Renderer {
  constructor(agent) {
    this.agent = agent;
    this.file = null;
    this.chatDivider = null;
    this.feedDivider = null;
    this.calls = [];
    this.lastChat = null;
    this.echo = null;
    this.lastQuestion = null;
    this.out = { chat: [], feed: [] };
  }

  /** Returns the new chat and feed nodes, in order. Some events update earlier nodes instead. */
  render(events) {
    this.out = { chat: [], feed: [] };
    for (const event of events) {
      try {
        this.add(event);
      } catch (err) {
        console.error("Couldn't show an event", event, err);
      }
    }
    return this.out;
  }

  /** Marks calls that will never get a result here (session ended, or the result is on a later page). */
  closeCalls(text) {
    for (const call of this.calls.splice(0)) {
      call.status.className = "tool-status";
      call.status.textContent = text;
    }
  }

  markOpenQuestion(asking) {
    this.lastQuestion?.classList.toggle("open", asking);
  }

  pushChat(node) {
    if (this.chatDivider) this.out.chat.push(divider(this.chatDivider));
    this.chatDivider = null;
    this.out.chat.push(node);
  }

  pushFeed(node) {
    if (this.feedDivider) this.out.feed.push(divider(this.feedDivider));
    this.feedDivider = null;
    this.out.feed.push(node);
  }

  chat(className, who, t, text, extra) {
    const bubble = el("div", "bubble", text);
    const meta = el("div", "meta", who, " · ", clock(t));
    if (t) meta.title = new Date(t).toLocaleString();
    const node = el("div", `msg ${className}`, meta, bubble, extra);
    this.pushChat(node);
    return { node, bubble };
  }

  feed(kind, className, t, tag, ...body) {
    const node = el("div", `item ${className} k-${kind}`, el("div", "item-head", timeEl(t), el("span", "tag", tag)), ...body);
    this.pushFeed(node);
    return node;
  }

  add(e) {
    const file = e.id.slice(0, e.id.lastIndexOf(":"));
    if (file !== this.file) {
      if (this.file) this.closeCalls("no result (session ended)");
      this.file = file;
      this.chatDivider = file;
      this.feedDivider = file;
      this.lastChat = null;
      this.echo = null;
    }
    const text = typeof e.text === "string" ? e.text : "";
    switch (e.event) {
      case "message_in":
        return this.messageIn(e, text);
      case "chat_out":
        return this.chatOut(e, text);
      case "question":
        return this.question(e, text);
      case "thinking":
        return this.feed("thinking", "thinking", e.t, "Thinking", clampedText(text, "thinking-text"));
      case "plan":
        return this.plan(e);
      case "tool_call":
        return this.toolCall(e);
      case "tool_result":
        return this.toolResult(e);
      case "script_log":
        return this.scriptLog(e, text);
      case "game_event":
        return this.gameEvent(e, text);
      case "info":
        if (text.startsWith(NOT_SENT)) {
          this.lastChat = null;
          return this.chat("agent quiet", `${this.agent} · not sent to chat`, e.t, text.slice(NOT_SENT.length));
        }
        return this.feed("events", "info", e.t, "Info", el("div", "text", text));
      case "warn":
        return this.feed("events", "warn", e.t, "Warning", el("div", "text", text));
      case "error":
        return this.feed("events", "error", e.t, "Error", el("div", "text", text), e.detail ? el("details", "detail", el("summary", null, "Details"), el("pre", null, pretty(e.detail))) : null);
      case "usage":
        return this.usage(e);
      case "response":
      case "narrate":
        return; // the raw API response, and the plan whispers (shown as plan items)
      default: {
        const { id, t, event, ...rest } = e;
        return this.feed("events", "info", t, String(event ?? "event"), el("pre", null, JSON.stringify(rest, null, 2)));
      }
    }
  }

  messageIn(e, text) {
    const from = typeof e.from === "string" ? e.from : "unknown";
    this.lastChat = null;
    if (from === "survival") return this.feed("events", "survival", e.t, "Survival", el("div", "text", text));
    if (from.endsWith(" (teammate)")) return this.chat("teammate", from, e.t, text);
    const who = from === "dashboard" ? "You (dashboard)" : from === "console" ? "You (terminal)" : from;
    this.chat("sup", who, e.t, text);
  }

  chatOut(e, text) {
    // The question was already shown; skip its "Question: ..." copy in chat (possibly split over lines).
    const squeezed = text.replace(/\s+/g, "");
    if (this.echo && squeezed && this.echo.startsWith(squeezed)) {
      this.echo = this.echo.slice(squeezed.length) || null;
      return;
    }
    this.echo = null;
    const time = Date.parse(e.t);
    const last = this.lastChat;
    // Chat lines are capped at 250 characters, so a long reply arrives as several lines at once.
    if (last && time - last.time < 1500) {
      last.bubble.append(last.length >= 200 ? " " : "\n", text);
      last.length = text.length;
      last.time = time;
      return;
    }
    const { bubble } = this.chat("agent", this.agent, e.t, text);
    this.lastChat = { bubble, time, length: text.length };
  }

  question(e, text) {
    this.lastChat = null;
    this.echo = `Question:${text}`.replace(/\s+/g, "");
    const answer = el("button", "answer", "Answer");
    answer.type = "button";
    answer.addEventListener("click", () => $("chat-input").focus());
    const { node } = this.chat("agent question", `${this.agent} asks`, e.t, text, answer);
    this.lastQuestion = node;
  }

  plan(e) {
    const steps = Array.isArray(e.steps) ? e.steps : [];
    this.feed(
      "plan",
      "plan",
      e.t,
      "Plan",
      el("div", "text", el("b", null, String(e.goal ?? ""))),
      el("ol", "steps", steps.map((s) => el("li", stepClass(s?.status), String(s?.step ?? "")))),
    );
  }

  toolCall(e) {
    const name = String(e.name ?? "tool");
    const input = e.input && typeof e.input === "object" ? e.input : {};
    const script = name === "run_code" && typeof input.code === "string";
    const status = el("span", "tool-status running", "running…");
    const preview = el("span", "tool-preview");
    preview.hidden = true;
    const args = script ? String(input.purpose ?? "script") : JSON.stringify(input).slice(0, 300);
    const summary = el("summary", null, el("span", "item-head", el("span", "caret"), timeEl(e.t), el("span", "tool-name", name), el("span", "tool-args", args), status), preview);
    const body = el("div", "tool-body");
    if (script) {
      const { code, purpose, ...rest } = input;
      body.append(el("div", "label", "Script"), el("pre", null, code));
      if (Object.keys(rest).length) body.append(el("div", "label", "Arguments"), el("pre", null, pretty(rest)));
    } else {
      body.append(el("div", "label", "Input"), el("pre", null, pretty(input)));
    }
    const node = el("div", "item tool k-tools", el("details", null, summary, body));
    this.pushFeed(node);
    this.calls.push({ name, node, status, preview, body, logs: null });
  }

  toolResult(e) {
    const name = String(e.name ?? "tool");
    const output = pretty(e.output ?? "");
    const failed = Boolean(e.isError);
    const ms = Number(e.ms);
    const took = Number.isFinite(ms) ? ` · ${(ms / 1000).toFixed(1)}s` : "";
    const index = this.calls.findLastIndex((c) => c.name === name);
    if (index < 0) {
      // Its call is on an earlier page of history.
      const summary = el("summary", null, el("span", "item-head", el("span", "caret"), timeEl(e.t), el("span", "tool-name", name), el("span", "tool-args", "result"), el("span", `tool-status ${failed ? "err" : "ok"}`, `${failed ? "failed" : "done"}${took}`)), el("span", `tool-preview${failed ? " err" : ""}`, firstLine(output)));
      const body = el("div", "tool-body", el("div", "label", "Result"), el("pre", failed ? "err" : null, output));
      return this.pushFeed(el("div", `item tool k-tools${failed ? " failed" : ""}`, el("details", null, summary, body)));
    }
    const [call] = this.calls.splice(index, 1);
    call.status.className = `tool-status ${failed ? "err" : "ok"}`;
    call.status.textContent = `${failed ? "failed" : "done"}${took}`;
    call.preview.hidden = false;
    call.preview.className = `tool-preview${failed ? " err" : ""}`;
    call.preview.textContent = firstLine(output);
    call.node.classList.toggle("failed", failed);
    call.body.append(el("div", "label", "Result"), el("pre", failed ? "err" : null, output));
  }

  scriptLog(e, text) {
    // Script output belongs to the script that's running: the latest open call.
    const call = this.calls.at(-1);
    if (!call) return this.feed("tools", "info", e.t, "Script log", el("div", "text", text));
    if (!call.logs) {
      call.logs = el("div", "log-lines mono");
      call.body.append(el("div", "label", "Log"), call.logs);
    }
    call.logs.append(el("div", null, text));
    call.preview.hidden = false;
    call.preview.textContent = firstLine(text);
  }

  gameEvent(e, text) {
    const toMate = text.match(TEAMMATE_OUT);
    if (toMate) {
      this.lastChat = null;
      return this.chat("teammate out", `${this.agent} to ${toMate[1]}${toMate[2] ? " (wants a reply)" : ""}`, e.t, toMate[3]);
    }
    if (text.startsWith("Reflex: ")) return this.feed("events", "event", e.t, "Reflex", el("div", "text", text.slice(8)));
    const death = /^(Died at|You died)/.test(text);
    this.feed("events", death ? "error" : "event", e.t, death ? "Death" : "Event", el("div", "text", text));
  }

  usage(e) {
    const line = `${tokens(inputTokens(e))} in (${tokens(e.cacheRead)} cached) · ${tokens(e.output)} out · ${money(e.cost)}`;
    this.pushFeed(el("div", "item usage k-usage", el("div", "item-head", timeEl(e.t), el("span", null, line))));
  }
}

// ---- Agent view ----------------------------------------------------------------------------

const chatLog = $("chat-log");
const feedLog = $("feed-log");

/** Follows new content at the bottom unless the reader has scrolled up to read. */
function makeScroller(box, log, jump) {
  let stick = true;
  let lastTop = 0;
  const toBottom = () => {
    box.scrollTop = box.scrollHeight;
    stick = true;
    jump.hidden = true;
  };
  box.addEventListener("scroll", () => {
    // Only the reader scrolling up unpins it; layout changes can fire scroll events too.
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 48) stick = true;
    else if (box.scrollTop < lastTop) stick = false;
    lastTop = box.scrollTop;
    if (stick) jump.hidden = true;
  });
  jump.addEventListener("click", toBottom);
  // Stay at the bottom when the pane resizes or items grow in place (a tool result
  // arriving), but not when the reader expanded something: leave that where it is.
  let clickedAt = -Infinity;
  log.addEventListener("click", () => (clickedAt = performance.now()));
  const follow = new ResizeObserver(() => {
    if (performance.now() - clickedAt < 500) stick = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    else if (stick) box.scrollTop = box.scrollHeight;
  });
  follow.observe(box);
  follow.observe(log);
  return {
    toBottom,
    added(anythingNew) {
      if (stick) box.scrollTop = box.scrollHeight;
      else if (anythingNew) jump.hidden = false;
    },
  };
}

const chatScroller = makeScroller($("chat-scroll"), chatLog, $("chat-jump"));
const feedScroller = makeScroller($("feed-scroll"), feedLog, $("feed-jump"));
let current = null;

async function fetchEvents(name, before) {
  const params = new URLSearchParams({ limit: String(PAGE) });
  if (before) params.set("before", before);
  const res = await fetch(`/api/agents/${encodeURIComponent(name)}/events?${params}`);
  return res.ok ? res.json() : null;
}

function agentView(name) {
  showSection("agent");
  document.title = `${name} · agentcraft`;
  chatLog.replaceChildren();
  feedLog.replaceChildren();
  $("chat-input").value = "";
  note("");
  const view = {
    name,
    row: undefined,
    seen: new Set(),
    renderer: new Renderer(name),
    more: null,
    ready: false,
    pending: [],
    close: () => {
      source.close();
      if (current === view) current = null;
    },
  };
  current = view;
  updateHeader(view, undefined);
  const source = openStream(name, {
    overview: (data) => updateHeader(view, data.agents.find((a) => a.name === name) ?? null),
    transcript: (event) => (view.ready ? append(view, [event]) : view.pending.push(event)),
    reconnected: () => void catchUp(view),
  });
  void loadLatest(view);
  return view;
}

async function loadLatest(view) {
  const page = await fetchEvents(view.name).catch(() => null);
  if (current !== view) return;
  view.more = page?.more ?? null;
  append(view, page?.events ?? []);
  // Lines that arrived while the history loaded.
  append(view, view.pending.splice(0));
  view.ready = true;
  chatScroller.toBottom();
  feedScroller.toBottom();
  updateEmpty(view);
}

/** After a dropped connection: whatever was logged meanwhile. */
async function catchUp(view) {
  const page = await fetchEvents(view.name).catch(() => null);
  if (current === view && page) append(view, page.events);
}

function append(view, events) {
  const fresh = events.filter((e) => typeof e?.id === "string" && !view.seen.has(e.id));
  for (const e of fresh) view.seen.add(e.id);
  if (!fresh.length) return;
  const { chat, feed } = view.renderer.render(fresh);
  chatLog.append(...chat);
  feedLog.append(...feed);
  view.renderer.markOpenQuestion(Boolean(view.row?.asking));
  chatScroller.added(chat.length > 0);
  feedScroller.added(feed.length > 0);
  updateEmpty(view);
}

async function loadOlder(view) {
  if (!view?.more) return;
  const page = await fetchEvents(view.name, view.more).catch(() => null);
  if (current !== view || !page) return;
  view.more = page.more;
  const fresh = page.events.filter((e) => typeof e?.id === "string" && !view.seen.has(e.id));
  for (const e of fresh) view.seen.add(e.id);
  const renderer = new Renderer(view.name);
  const { chat, feed } = renderer.render(fresh);
  renderer.closeCalls("result further down");
  prepend(chatLog, $("chat-scroll"), chat);
  prepend(feedLog, $("feed-scroll"), feed);
  updateEmpty(view);
}

/** Adds older items at the top without moving what the reader is looking at. */
function prepend(log, box, nodes) {
  if (!nodes.length) return;
  const before = box.scrollHeight;
  // The older page ends in the session the shown history starts with: keep one divider for it.
  const first = log.firstElementChild;
  const lastDivider = nodes.findLast((n) => n.classList.contains("divider"));
  if (first?.classList.contains("divider") && first.dataset.file === lastDivider?.dataset.file) first.remove();
  log.prepend(...nodes);
  box.scrollTop += box.scrollHeight - before;
}

function updateEmpty(view) {
  for (const button of document.querySelectorAll("[data-older]")) button.hidden = !view.more;
  $("chat-empty").hidden = !view.ready || chatLog.children.length > 0;
  $("feed-empty").hidden = !view.ready || feedLog.children.length > 0;
}

/** The header, from the agent's overview row (undefined while loading, null if there's no such agent). */
function updateHeader(view, row) {
  view.row = row;
  const state = agentState(row);
  $("a-name").textContent = view.name;
  $("a-dot").className = dotClass(row);
  $("a-team").hidden = !row?.team;
  $("a-team").textContent = row?.team ?? "";
  $("a-state").className = `state ${state.cls}`;
  $("a-state").textContent = row === undefined ? "loading…" : row === null ? "no agent by this name" : state.text;
  $("a-meta").textContent = row ? describeModel(row) : "";

  const u = row?.usage;
  $("a-session-label").textContent = row?.online ? "This session" : "Last session";
  $("a-cost-session").textContent = u ? money(u.session.cost) : "–";
  $("a-cost-today").textContent = u ? money(u.today.cost) : "–";
  $("a-cost-all").textContent = u ? money(u.allTime.cost) : "–";
  $("a-requests").textContent = u ? u.allTime.requests.toLocaleString() : "–";
  $("a-tokens").textContent = u ? `${tokens(inputTokens(u.allTime))} / ${tokens(u.allTime.output)}` : "–";
  const live = row?.online && row.live
    ? [vitals(row.live), el("div", "muted", whereabouts(row.live))]
    : [el("span", "muted", row?.online ? "Joining the world…" : row ? `Not running · last active ${ago(row.lastActivity)}` : "–")];
  $("a-live").replaceChildren(...live);

  const strip = $("a-plan");
  const steps = Array.isArray(row?.plan?.steps) ? row.plan.steps : [];
  strip.hidden = !steps.length;
  if (steps.length) {
    strip.replaceChildren(
      el("span", "tag", row.online ? "Plan" : "Last plan"),
      el("span", "goal", row.plan.goal),
      ...steps.map((s, i) => el("span", stepClass(s.status), `${i + 1}. ${s.step}`)),
    );
  }

  const online = Boolean(row?.online);
  $("chat-input").disabled = !online;
  $("send").disabled = !online;
  $("stop").disabled = !online;
  $("chat-input").placeholder = online ? `Message ${view.name} (Enter to send, Shift+Enter for a new line)` : `${view.name} isn't running, so it can't get messages.`;
  $("asking-banner").hidden = !row?.asking;
  view.renderer.markOpenQuestion(Boolean(row?.asking));
  // A stopped agent's last tool call will never get its result.
  if (row && !online) view.renderer.closeCalls("no result (agent stopped)");
}

// ---- Talking to the agent -------------------------------------------------------------------

let noteTimer = null;
function note(text, error = false) {
  const node = $("chat-note");
  node.textContent = text;
  node.classList.toggle("error", error);
  clearTimeout(noteTimer);
  if (text && !error) noteTimer = setTimeout(() => (node.textContent = ""), 4000);
}

async function send(text, onSent) {
  const view = current;
  if (!view) return;
  $("send").disabled = true;
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(view.name)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Couldn't send (HTTP ${res.status}).`);
    onSent?.();
    note(text === "/stop" ? "Told it to stop." : "Sent.");
  } catch (err) {
    note(err instanceof Error ? err.message : String(err), true);
  } finally {
    $("send").disabled = !view.row?.online;
  }
}

$("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (text) void send(text, () => (input.value = ""));
});
$("chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("chat-form").requestSubmit();
  }
});
$("stop").addEventListener("click", () => void send("/stop"));
for (const button of document.querySelectorAll("[data-older]")) button.addEventListener("click", () => void loadOlder(current));

// Activity filters, remembered between visits.
const FILTERS_KEY = "mc-dashboard-hidden-kinds";
let hiddenKinds;
try {
  hiddenKinds = new Set(JSON.parse(localStorage.getItem(FILTERS_KEY) ?? '["usage"]'));
} catch {
  hiddenKinds = new Set(["usage"]);
}
for (const box of document.querySelectorAll(".filters input")) {
  const kind = box.dataset.kind;
  box.checked = !hiddenKinds.has(kind);
  feedLog.classList.toggle(`hide-${kind}`, !box.checked);
  box.addEventListener("change", () => {
    if (box.checked) hiddenKinds.delete(kind);
    else hiddenKinds.add(kind);
    feedLog.classList.toggle(`hide-${kind}`, !box.checked);
    localStorage.setItem(FILTERS_KEY, JSON.stringify([...hiddenKinds]));
    feedScroller.added(false);
  });
}

// ---- Routing: #/ is home, #/agent/<name> is one agent ------------------------------------------

let view = null;
function route() {
  view?.close();
  let name = null;
  try {
    const match = location.hash.match(/^#\/agent\/(.+)$/);
    name = match ? decodeURIComponent(match[1]) : null;
  } catch {
    name = null;
  }
  view = name ? agentView(name) : homeView();
}
window.addEventListener("hashchange", route);
route();
