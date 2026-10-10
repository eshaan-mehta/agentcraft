// Lets the local dashboard (npm run dashboard) watch and talk to this agent. Every two
// seconds the agent writes a small status file, runtime/agents/<name>.json, and it
// handles lines the dashboard appends to runtime/agents/<name>.inbox.jsonl as if they
// were typed in its terminal. Nothing here changes what the agent decides.
import fs from "node:fs";
import path from "node:path";
import type { Bot } from "mineflayer";
import type { Agent } from "./brain/agent.js";
import { config, team } from "./config.js";
import { errorText } from "./errors.js";
import { status, type Pos } from "./world/perception.js";

/** What the bot is doing in the world right now. */
export interface LiveStatus {
  position: Pos;
  dimension: string;
  health: number;
  food: number;
  /** day, sunset, night, or sunrise. */
  phase: string;
  timeOfDay: number;
  sheltered: boolean;
  holding: string | null;
  /** Hostile mobs within 16 blocks, by kind. */
  hostiles: Record<string, number>;
  sleeping: boolean;
  raining: boolean;
}

/** The contents of runtime/agents/<name>.json. */
export interface RuntimeEntry {
  name: string;
  team: string | null;
  model: string;
  effort: string;
  askMode: string;
  pid: number;
  startedAt: string;
  /** Rewritten every couple of seconds; an old value means the agent stopped or hung. */
  updatedAt: string;
  transcriptPath: string;
  inboxPath: string;
  busy: boolean;
  /** Waiting for the supervisor to answer a question. */
  asking: boolean;
  plan: { goal: string; steps: { step: string; status: string }[] } | null;
  /** This session's token usage and estimated cost. */
  usage: { requests: number; input: number; cacheRead: number; cacheWrite: number; output: number; cost: number };
  /** Null while the bot isn't fully in the world (e.g. mid-respawn). */
  live: LiveStatus | null;
}

export function runtimePaths(dir: string, name: string) {
  const agents = path.resolve(dir, "agents");
  return { status: path.join(agents, `${name}.json`), inbox: path.join(agents, `${name}.inbox.jsonl`) };
}

/**
 * Writes `snapshot()` to `file` now and every `intervalMs`, through a temp file and a
 * rename so a reader never sees half of it. Returns a function that stops and deletes it.
 */
export function publishStatus(file: string, snapshot: () => unknown, intervalMs = 2_000, onError?: (err: unknown) => void): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  let failing = false;
  const write = () => {
    try {
      fs.writeFileSync(tmp, JSON.stringify(snapshot(), null, 2));
      fs.renameSync(tmp, file);
      failing = false;
    } catch (err) {
      // Report the first failure, not one every two seconds.
      if (!failing) onError?.(err);
      failing = true;
    }
  };
  write();
  const timer = setInterval(write, intervalMs);
  timer.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    fs.rmSync(file, { force: true });
    fs.rmSync(tmp, { force: true });
  };
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** The text of an inbox line ({"t": ..., "text": ...}), or null if it isn't a valid one. */
function inboxText(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as { text?: unknown };
    return typeof parsed.text === "string" && parsed.text.trim() ? parsed.text : null;
  } catch {
    return null;
  }
}

/**
 * Calls `onLine` with the text of each line appended to the inbox file, exactly once.
 * Lines already there when it starts are skipped: they were for an earlier run. It uses
 * fs.watch for speed and also polls, since file watching is unreliable on some systems.
 * Returns a function that stops watching.
 */
export function watchInbox(file: string, onLine: (text: string) => void, pollMs = 1_000, onError?: (err: unknown) => void): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let offset = sizeOf(file);

  const check = () => {
    const size = sizeOf(file);
    if (size < offset) offset = 0; // deleted or replaced: everything in the new file is new
    if (size <= offset) return;
    const chunk = Buffer.alloc(size - offset);
    const fd = fs.openSync(file, "r");
    let read: number;
    try {
      read = fs.readSync(fd, chunk, 0, chunk.length, offset);
    } finally {
      fs.closeSync(fd);
    }
    // Only whole lines; a line still being written is picked up next time.
    const end = chunk.subarray(0, read).lastIndexOf(0x0a);
    if (end < 0) return;
    // Move past the lines before handling them, so a handler that throws can't cause a repeat.
    offset += end + 1;
    for (const line of chunk.subarray(0, end).toString("utf8").split("\n")) {
      const text = inboxText(line);
      if (!text) continue;
      try {
        onLine(text);
      } catch (err) {
        onError?.(err);
      }
    }
  };
  const safeCheck = () => {
    try {
      check();
    } catch (err) {
      onError?.(err);
    }
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(path.dirname(file), { persistent: false }, (_, name) => {
      if (!name || name === path.basename(file)) safeCheck();
    });
    watcher.on("error", () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    // Polling below still delivers everything, just a little later.
  }
  const timer = setInterval(safeCheck, pollMs);
  timer.unref();
  return () => {
    watcher?.close();
    clearInterval(timer);
  };
}

function liveStatus(bot: Bot): LiveStatus | null {
  try {
    const s = status(bot);
    return {
      position: s.position,
      dimension: s.dimension,
      health: s.health,
      food: s.food,
      phase: s.time.phase,
      timeOfDay: s.time.timeOfDay,
      sheltered: s.sheltered,
      holding: s.equipment.hand ?? null,
      hostiles: s.hostilesNearby,
      sleeping: s.sleeping,
      raining: s.raining,
    };
  } catch {
    return null;
  }
}

export interface RuntimeDeps {
  bot: Bot;
  agent: Agent;
  transcriptPath: string;
  /** Handles the text of an inbox line, the same way as a line typed in the terminal. */
  onLine: (text: string) => void;
  onError: (message: string) => void;
}

/** Publishes this agent's status for the dashboard and starts reading its inbox, until the process exits. */
export function startRuntime({ bot, agent, transcriptPath, onLine, onError }: RuntimeDeps) {
  const name = config.mc.username;
  const paths = runtimePaths(config.runtimeDir, name);
  const startedAt = new Date().toISOString();
  const snapshot = (): RuntimeEntry => ({
    name,
    team: team.name,
    model: config.claude.model,
    effort: config.claude.effort,
    askMode: config.askMode,
    pid: process.pid,
    startedAt,
    updatedAt: new Date().toISOString(),
    transcriptPath: path.resolve(transcriptPath),
    inboxPath: paths.inbox,
    ...agent.state(),
    live: liveStatus(bot),
  });
  const stopStatus = publishStatus(paths.status, snapshot, 2_000, (err) => onError(`Couldn't write the dashboard status file: ${errorText(err)}`));
  const stopInbox = watchInbox(paths.inbox, onLine, 1_000, (err) => onError(`Couldn't handle a dashboard message: ${errorText(err)}`));

  // Remove the status file on the way out, so the dashboard shows the agent offline right away.
  const stop = () => {
    stopInbox();
    stopStatus();
  };
  process.on("exit", stop);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stop();
      // With this handler gone, the signal ends the process the way it always did.
      process.kill(process.pid, signal);
    });
  }
}
