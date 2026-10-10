// Keeps the agent's conversation across restarts. The full history is saved after
// every step and restored on startup; when there's nothing to restore (first run, or
// coming from an older version), the previous session's transcript is condensed into
// a briefing instead.
import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type Message = Anthropic.Beta.BetaMessageParam;

export interface SavedSession {
  version: 1;
  model: string;
  /** Hash of the system prompt and tool definitions the history was produced with. */
  fingerprint: string;
  savedAt: string;
  messages: Message[];
}

export function fingerprint(system: string, tools: unknown[]): string {
  return createHash("sha256").update(JSON.stringify({ system, tools })).digest("hex").slice(0, 16);
}

export class SessionStore {
  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  load(): SavedSession | null {
    if (!fs.existsSync(this.file)) return null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as SavedSession;
      return saved.version === 1 && Array.isArray(saved.messages) ? saved : null;
    } catch {
      return null;
    }
  }

  save(model: string, print: string, messages: Message[]) {
    const data: SavedSession = { version: 1, model, fingerprint: print, savedAt: new Date().toISOString(), messages };
    // Write-then-rename so stopping the agent mid-write can't corrupt the file.
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.file);
  }

  clear() {
    fs.rmSync(this.file, { force: true });
  }
}

/** Tool names used anywhere in a history, to check they all still exist. */
export function toolsUsed(messages: Message[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) if (block.type === "tool_use") names.add(block.name);
  }
  return names;
}

/**
 * Makes a restored history safe to continue: if it ends with tool calls that never got
 * results (the agent stopped mid-step), adds results saying so.
 */
export function closeOpenToolCalls(messages: Message[]): Message[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || typeof last.content === "string") return messages;
  const open = last.content.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use");
  if (!open.length) return messages;
  return [
    ...messages,
    {
      role: "user",
      content: open.map((call) => ({ type: "tool_result" as const, tool_use_id: call.id, is_error: true, content: "Not run: the agent was restarted before this step finished." })),
    },
  ];
}

interface TranscriptEvent {
  t: string;
  event: string;
  text?: string;
  from?: string;
  name?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  goal?: string;
  steps?: { step: string; status: string }[];
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/**
 * A condensed account of the most recent previous session, from its transcript, for
 * when there's no saved conversation to restore. Null if there's no recent session.
 */
export function briefingFromTranscripts(logDir: string, currentTranscript: string, maxAgeHours = 48): string | null {
  if (!fs.existsSync(logDir)) return null;
  const candidates = fs
    .readdirSync(logDir)
    .filter((name) => name.endsWith(".jsonl") && path.join(logDir, name) !== currentTranscript)
    .sort()
    .reverse();
  for (const name of candidates) {
    const file = path.join(logDir, name);
    if (Date.now() - fs.statSync(file).mtimeMs > maxAgeHours * 3_600_000) return null;
    const events = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as TranscriptEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is TranscriptEvent => e !== null);
    if (!events.some((e) => e.event === "message_in")) continue;

    const lines: string[] = [];
    for (const e of events) {
      const time = e.t.slice(11, 16);
      if (e.event === "message_in") lines.push(`${time} ${e.from === "survival" ? "[survival]" : `<${e.from}>`} ${clip(e.text ?? "", 220)}`);
      else if (e.event === "chat_out") lines.push(`${time} you said: ${clip(e.text ?? "", 220)}`);
      else if (e.event === "tool_call") lines.push(`${time} you used ${e.name} ${clip(JSON.stringify(e.input ?? {}), 100)}`);
      else if (e.event === "tool_result") lines.push(`      -> ${e.isError ? "FAILED: " : ""}${clip(e.output ?? "", 160)}`);
      else if (e.event === "game_event") lines.push(`${time} [event] ${clip(e.text ?? "", 160)}`);
      else if (e.event === "plan") lines.push(`${time} [plan] ${e.goal}: ${(e.steps ?? []).map((s) => `${s.step} (${s.status})`).join("; ")}`);
    }
    // Keep the most recent part, within a reasonable size.
    const kept: string[] = [];
    let size = 0;
    for (const line of lines.reverse()) {
      if (size + line.length > 5_000) break;
      kept.unshift(line);
      size += line.length + 1;
    }
    return [
      `[previous session] You were restarted and don't have your earlier conversation. Here is a condensed log of the previous session (${name.replace(/^session-|\.jsonl$/g, "").slice(0, 16)} UTC), oldest first${kept.length < lines.length ? ", most recent part only" : ""}. Your inventory, position, and the world carried over; trust [status] and observe over this log. If you were in the middle of a task, don't resume it unless the supervisor asks.`,
      ...kept,
    ].join("\n");
  }
  return null;
}
