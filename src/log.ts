import fs from "node:fs";
import path from "node:path";
import { styleText } from "node:util";
import { config } from "./config.js";

// Everything printed to the terminal is also appended to a JSONL transcript so a
// session can be replayed or analyzed after the fact.
fs.mkdirSync(config.logDir, { recursive: true });
const transcriptPath = path.join(
  config.logDir,
  `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
);
const transcript = fs.createWriteStream(transcriptPath, { flags: "a" });

function record(event: string, data: Record<string, unknown>) {
  transcript.write(JSON.stringify({ t: new Date().toISOString(), event, ...data }) + "\n");
}

function print(prefix: string, text: string) {
  const time = styleText("gray", new Date().toLocaleTimeString());
  console.log(`${time} ${prefix} ${text}`);
}

function truncate(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text;
}

export const log = {
  transcriptPath,

  info(text: string) {
    print(styleText("blue", "ℹ"), text);
    record("info", { text });
  },
  warn(text: string) {
    print(styleText("yellow", "⚠"), styleText("yellow", text));
    record("warn", { text });
  },
  error(text: string, detail?: unknown) {
    print(styleText("red", "✖"), styleText("red", text));
    record("error", { text, detail: detail instanceof Error ? detail.stack : detail });
  },

  incoming(from: string, text: string) {
    print(styleText("cyan", "📩"), `${styleText("bold", `<${from}>`)} ${text}`);
    record("message_in", { from, text });
  },
  outgoing(text: string) {
    print(styleText("green", "💬"), styleText("green", text));
    record("chat_out", { text });
  },
  thinking(text: string) {
    print(styleText("magenta", "💭"), styleText(["dim", "italic"], text));
    record("thinking", { text });
  },
  toolCall(name: string, input: unknown) {
    print(styleText("yellow", "🔧"), `${styleText("bold", name)} ${styleText("dim", truncate(JSON.stringify(input), 300))}`);
    record("tool_call", { name, input });
  },
  /** A script the agent is about to run, shown in full so you can see what it's doing. */
  script(purpose: string, code: string) {
    print(styleText("yellow", "📜"), styleText("bold", purpose));
    for (const line of code.split("\n")) console.log(styleText("gray", `      │ ${line}`));
  },
  /** Output from a running script's log() calls. */
  scriptOutput(text: string) {
    print(styleText("gray", "  ┊"), styleText("gray", truncate(text, 300)));
    record("script_log", { text });
  },
  plan(goal: string, steps: { step: string; status: string }[]) {
    const icon: Record<string, string> = { done: "✔", doing: "▶", todo: "·", blocked: "✖", skipped: "–" };
    print(styleText("cyan", "📋"), styleText("bold", goal));
    for (const s of steps) console.log(`      ${icon[s.status] ?? "·"} ${s.status === "doing" ? styleText("bold", s.step) : s.step}`);
    record("plan", { goal, steps });
  },
  question(text: string) {
    print(styleText("cyan", "❓"), styleText(["bold", "cyan"], text));
    record("question", { text });
  },
  toolResult(name: string, output: string, isError: boolean, ms: number) {
    const icon = isError ? styleText("red", "  ✗") : styleText("green", "  ✓");
    const timing = styleText("gray", `(${(ms / 1000).toFixed(1)}s)`);
    print(icon, `${truncate(output)} ${timing}`);
    record("tool_result", { name, output, isError, ms });
  },
  event(text: string) {
    print(styleText("blue", "◆"), text);
    record("game_event", { text });
  },
  usage(text: string, data: Record<string, unknown>) {
    print(styleText("gray", "Σ"), styleText("gray", text));
    record("usage", data);
  },
  raw(event: string, data: Record<string, unknown>) {
    record(event, data);
  },
};
