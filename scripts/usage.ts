// Totals token usage and estimated cost across every saved session transcript,
// broken down by agent when several have run (logs/<name>/).
// Run with: npm run usage
import fs from "node:fs";
import { config } from "../src/config.js";
import { addTotals, addUsage, blankTotals, findTranscripts, type Totals } from "./transcripts.js";

function addFile(file: string, totals: Totals) {
  let counted = false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"event":"usage"')) continue;
    addUsage(totals, JSON.parse(line) as Record<string, unknown>);
    counted = true;
  }
  if (counted) totals.sessions++;
}

function format(label: string, t: Totals): string {
  const input = t.input + t.cacheRead + t.cacheWrite;
  return `${label.padEnd(14)} ${String(t.sessions).padStart(3)} sessions ${String(t.requests).padStart(5)} requests  ${input.toLocaleString().padStart(12)} in (${t.cacheRead.toLocaleString()} cached)  ${t.output.toLocaleString().padStart(9)} out  ≈$${t.cost.toFixed(2)}`;
}

const groups = new Map<string, Totals>();
for (const { file, agent } of findTranscripts(config.logDir)) {
  const label = agent ?? "(single agent)";
  addFile(file, groups.get(label) ?? groups.set(label, blankTotals()).get(label)!);
}
for (const [label, t] of groups) if (!t.requests) groups.delete(label);

const all = blankTotals();
for (const t of groups.values()) addTotals(all, t);
if (groups.size > 1) for (const [label, t] of groups) console.log(format(label, t));
console.log(format("Total", all));
console.log("Costs are estimates; your Anthropic Console has the exact billed amount.");
