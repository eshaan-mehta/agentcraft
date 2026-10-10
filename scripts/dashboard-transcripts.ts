// The dashboard's view of the session transcripts: per-file usage and latest state,
// kept current by reading only what's been appended since the last look, and pages of
// history for the agent view. Every event gets a stable id, "<file name>:<line>", so the
// page can merge history with live updates without showing anything twice.
import fs from "node:fs";
import path from "node:path";
import { addUsage, blankTotals, findTranscripts, type Totals } from "./transcripts.js";

export type TranscriptEvent = { id: string; t?: string; event?: string } & Record<string, unknown>;
export type Plan = { goal: string; steps: { step: string; status: string }[] };

export interface FileState {
  /** Absolute path, symlinks resolved. */
  file: string;
  /** The file name, used in event ids. */
  name: string;
  /** From the folder (logs/<name>/); null for a file directly in logs/. */
  dirAgent: string | null;
  /** The bot's name from the session's first line ("Connecting to ... as Name"), if seen. */
  username: string | null;
  /** Bytes read so far, always at the end of a whole line. */
  offset: number;
  /** Lines read so far. */
  lines: number;
  usage: Totals;
  /** Usage by local date (YYYY-MM-DD). */
  days: Map<string, Totals>;
  lastT: string | null;
  model: string | null;
  /** undefined until the session says whether it's on a team. */
  team: string | null | undefined;
  plan: Plan | null;
}

// Read big transcripts a piece at a time rather than all at once.
const CHUNK = 4 * 1024 * 1024;
// Raw API responses are huge and duplicate the thinking, tool_call, and usage events.
const SKIPPED = '"event":"response"';
const MAX_STRING = 20_000;

export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function realPath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function skipped(line: string): boolean {
  return !line || line.slice(0, 120).includes(SKIPPED);
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Cuts very long strings (big scripts or tool outputs) so a page of events stays small. */
function trim(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length - MAX_STRING} more chars)` : value;
  if (Array.isArray(value)) return value.map(trim);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trim(v)]));
  return value;
}

function asPlan(event: Record<string, unknown>): Plan | null {
  if (typeof event.goal !== "string" || !Array.isArray(event.steps)) return null;
  const steps = event.steps
    .filter((s): s is { step: unknown; status: unknown } => Boolean(s) && typeof s === "object")
    .map((s) => ({ step: String(s.step ?? ""), status: String(s.status ?? "todo") }));
  return { goal: event.goal, steps };
}

export class TranscriptIndex {
  readonly files = new Map<string, FileState>();
  /** Transcripts outside the log folder that a running agent pointed us to, by path. */
  private readonly extra = new Map<string, string>();

  constructor(
    private readonly logDir: string,
    /** Called for each line appended after the first scan. */
    private readonly onEvent: (file: FileState, event: TranscriptEvent) => void = () => {},
  ) {}

  /** Also follows a transcript outside the log folder (an agent started with a different LOG_DIR). */
  follow(file: string, agent: string) {
    this.extra.set(realPath(file), agent);
  }

  /** Reads whatever was appended to each transcript since the last scan, and picks up new files. */
  scan(emit = true) {
    let found: { file: string; agent: string | null }[] = [];
    try {
      found = findTranscripts(this.logDir).map((t) => ({ file: realPath(t.file), agent: t.agent }));
    } catch {
      // A folder disappeared mid-listing; the next scan sees the new state.
    }
    for (const [file, agent] of this.extra) if (!found.some((f) => f.file === file) && isFile(file)) found.push({ file, agent });
    for (const { file, agent } of found) {
      let state = this.files.get(file);
      if (!state) {
        state = {
          file,
          name: path.basename(file),
          dirAgent: agent,
          username: null,
          offset: 0,
          lines: 0,
          usage: blankTotals(),
          days: new Map(),
          lastT: null,
          model: null,
          team: undefined,
          plan: null,
        };
        this.files.set(file, state);
      }
      try {
        this.readNew(state, emit);
      } catch (err) {
        // Deleted while we read it, or unreadable: try again next scan.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Couldn't read ${file}: ${String(err)}`);
      }
    }
  }

  private readNew(state: FileState, emit: boolean) {
    const size = sizeOf(state.file);
    if (size < state.offset) {
      // Truncated or replaced: start over.
      Object.assign(state, { offset: 0, lines: 0, usage: blankTotals(), days: new Map(), lastT: null, plan: null });
    }
    if (size <= state.offset) return;
    const fd = fs.openSync(state.file, "r");
    try {
      let chunkSize = CHUNK;
      while (state.offset < size) {
        const buffer = Buffer.alloc(Math.min(chunkSize, size - state.offset));
        const read = fs.readSync(fd, buffer, 0, buffer.length, state.offset);
        const end = buffer.subarray(0, read).lastIndexOf(0x0a);
        if (end < 0) {
          // No complete line yet: either it's still being written, or it's longer than a chunk.
          if (state.offset + read >= size) break;
          chunkSize *= 2;
          continue;
        }
        state.offset += end + 1;
        for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) this.ingest(state, line, state.lines++, emit);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private ingest(state: FileState, line: string, index: number, emit: boolean) {
    if (!line) return;
    if (skipped(line)) {
      state.model = line.slice(0, 400).match(/"model":"([^"]+)"/)?.[1] ?? state.model;
      return;
    }
    const event = parse(line);
    if (!event) return;
    const t = typeof event.t === "string" ? event.t : null;
    if (t) state.lastT = t;
    if (event.event === "usage") {
      if (!state.usage.requests) state.usage.sessions = 1;
      addUsage(state.usage, event);
      const day = t ? localDay(new Date(t)) : "unknown";
      let totals = state.days.get(day);
      if (!totals) state.days.set(day, (totals = { ...blankTotals(), sessions: 1 }));
      addUsage(totals, event);
    } else if (event.event === "plan") {
      state.plan = asPlan(event) ?? state.plan;
    } else if (event.event === "info" && typeof event.text === "string") {
      // The session's opening lines say who the bot is, its model, and its team.
      const text = event.text;
      state.username ??= text.match(/^Connecting to \S+ as (\S+) \(Minecraft/)?.[1] ?? null;
      state.model ??= text.match(/^Joined at .*\. Model ([\w.-]+),/)?.[1] ?? null;
      if (text.startsWith("Working alone")) state.team = null;
      else state.team = text.match(/^Team "([^"]+)"/)?.[1] ?? state.team;
    }
    if (emit) this.onEvent(state, { ...(trim(event) as Record<string, unknown>), id: `${state.name}:${index}` });
  }

  /**
   * Up to `limit` events from these files, oldest first, ending just before the event
   * `before` (or at the latest). `more` is the cursor for the page before this one.
   */
  history(files: FileState[], limit: number, before?: string): { events: TranscriptEvent[]; more: string | null } {
    const cut = before?.match(/^(.*):(\d+)$/);
    const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const events: TranscriptEvent[] = [];
    for (let f = sorted.length - 1; f >= 0 && events.length < limit; f--) {
      const state = sorted[f]!;
      if (cut && state.name > cut[1]!) continue;
      const stop = cut && state.name === cut[1] ? Number(cut[2]) : state.lines;
      const lines = this.readLines(state);
      for (let i = Math.min(stop, lines.length) - 1; i >= 0 && events.length < limit; i--) {
        const line = lines[i]!;
        if (skipped(line)) continue;
        const event = parse(line);
        if (event) events.push({ ...(trim(event) as Record<string, unknown>), id: `${state.name}:${i}` });
      }
    }
    events.reverse();
    return { events, more: events.length >= limit ? events[0]!.id : null };
  }

  /** The lines read so far (later ones arrive through scan), so ids match live updates. */
  private readLines(state: FileState): string[] {
    if (!state.offset) return [];
    const buffer = Buffer.alloc(state.offset);
    const fd = fs.openSync(state.file, "r");
    try {
      fs.readSync(fd, buffer, 0, state.offset, 0);
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString("utf8").split("\n").slice(0, state.lines);
  }
}
