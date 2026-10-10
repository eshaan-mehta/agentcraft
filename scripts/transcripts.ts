// Finding session transcripts and adding up their token usage. Shared by
// `npm run usage` and the dashboard.
import fs from "node:fs";
import path from "node:path";

export interface Totals {
  sessions: number;
  requests: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cost: number;
}

const USAGE_KEYS = ["input", "cacheRead", "cacheWrite", "output", "cost"] as const;

export const blankTotals = (): Totals => ({ sessions: 0, requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 });

/** Counts one `usage` event (one API request). Missing or odd fields count as zero. */
export function addUsage(totals: Totals, usage: Record<string, unknown>) {
  totals.requests++;
  for (const key of USAGE_KEYS) totals[key] += Number(usage[key]) || 0;
}

export function addTotals(into: Totals, from: Totals | undefined) {
  if (!from) return;
  for (const key of Object.keys(into) as (keyof Totals)[]) into[key] += from[key];
}

export interface Transcript {
  file: string;
  /** The agent's folder name (logs/<name>/), or null for a file directly in logs/ (a single agent). */
  agent: string | null;
}

/** Every session transcript under the log folder, in both layouts. */
export function findTranscripts(logDir: string): Transcript[] {
  if (!fs.existsSync(logDir)) return [];
  const found: Transcript[] = [];
  for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
    const full = path.join(logDir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      found.push({ file: full, agent: null });
    } else if (entry.isDirectory()) {
      for (const name of fs.readdirSync(full)) if (name.endsWith(".jsonl")) found.push({ file: path.join(full, name), agent: entry.name });
    }
  }
  return found;
}
