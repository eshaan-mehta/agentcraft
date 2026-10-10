// The dashboard's side of src/runtime.ts: reads the status files running agents write
// to runtime/agents/, and appends messages to their inboxes.
import fs from "node:fs";
import path from "node:path";
import type { RuntimeEntry } from "../src/runtime.js";

export interface RegistryEntry extends RuntimeEntry {
  /** Updated in the last 10 seconds by a process that still exists. */
  online: boolean;
}

const FRESH_MS = 10_000;

/** Whether a process exists. Signal 0 only checks; nothing is sent. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Every agent status file, fresh or stale (a crashed agent leaves its file behind). */
export function readRegistry(runtimeDir: string): RegistryEntry[] {
  const dir = path.resolve(runtimeDir, "agents");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const entries: RegistryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as RuntimeEntry;
      if (typeof entry.name !== "string" || !entry.name || typeof entry.transcriptPath !== "string" || typeof entry.inboxPath !== "string") continue;
      const age = Date.now() - Date.parse(entry.updatedAt);
      entries.push({ ...entry, online: age < FRESH_MS && alive(entry.pid) });
    } catch {
      // Not a status file, or deleted as we read it.
    }
  }
  return entries;
}

/** Appends a message to an agent's inbox; the agent handles it like a line typed in its terminal. */
export function sendToInbox(entry: RuntimeEntry, text: string) {
  if (!path.isAbsolute(entry.inboxPath) || !entry.inboxPath.endsWith(".inbox.jsonl")) throw new Error(`${entry.name} has no valid inbox path.`);
  fs.appendFileSync(entry.inboxPath, `${JSON.stringify({ t: new Date().toISOString(), text })}\n`);
}
