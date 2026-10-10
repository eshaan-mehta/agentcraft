// Runs several agents at once, each in its own process, from one terminal.
//
//   npm run agents -- Claude:red Bob:red Eve     name[:team]; no team = works alone
//   npm run agents                               reads agents.json
//
// Teammates share memory and saved skills (data/teams/<team>/); everyone else keeps
// their own (data/agents/<name>/). Each agent has its own conversation and logs.
// Type "@name message", "@team message", or "@all message" to talk to some of them;
// a message with no @ goes to all of them.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";

try {
  process.loadEnvFile();
} catch {
  // No .env file.
}

interface AgentSpec {
  name: string;
  team?: string | null;
  model?: string;
  effort?: string;
  askMode?: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = /^[A-Za-z0-9_]{3,16}$/;
const COLORS = ["cyan", "magenta", "yellow", "green", "blue", "red", "white"] as const;
const USAGE = `Usage:
  npm run agents -- Claude:red Bob:red Eve     (name[:team]; leave the team off to work alone)
  npm run agents                               (reads agents.json; see agents.example.json)`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function loadSpecs(args: string[]): AgentSpec[] {
  if (args.length) {
    return args.map((arg) => {
      const [name, team] = arg.split(":");
      return { name: name ?? "", team: team || null };
    });
  }
  const file = path.join(ROOT, "agents.json");
  if (!fs.existsSync(file)) fail("No agents given and no agents.json found.");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { agents?: AgentSpec[] } | AgentSpec[];
  return Array.isArray(parsed) ? parsed : (parsed.agents ?? []);
}

const specs = loadSpecs(process.argv.slice(2));
if (!specs.length) fail("No agents to start.");
const names = new Set<string>();
for (const spec of specs) {
  if (!NAME.test(spec.name)) fail(`"${spec.name}" isn't a valid Minecraft name (3-16 letters, digits, or _).`);
  if (names.has(spec.name.toLowerCase())) fail(`Two agents are named ${spec.name}.`);
  names.add(spec.name.toLowerCase());
  if (spec.team && !NAME.test(spec.team)) fail(`Team name "${spec.team}" must be 3-16 letters, digits, or _.`);
}
for (const spec of specs) {
  if (spec.team && names.has(spec.team.toLowerCase())) fail(`Team "${spec.team}" has the same name as an agent; pick a different team name.`);
}

const dataDir = process.env.DATA_DIR ?? "data";
const logDir = process.env.LOG_DIR ?? "logs";
const roster = specs.map((s) => (s.team ? `${s.name}:${s.team}` : s.name)).join(",");

interface Running {
  spec: AgentSpec;
  child: ChildProcess;
  label: string;
}
const running: Running[] = [];

function start(spec: AgentSpec, color: (typeof COLORS)[number]) {
  const own = path.join(dataDir, "agents", spec.name);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BOT_USERNAME: spec.name,
    AGENT_ROSTER: roster,
    DATA_DIR: own,
    KNOWLEDGE_DIR: spec.team ? path.join(dataDir, "teams", spec.team) : own,
    LOG_DIR: path.join(logDir, spec.name),
    FORCE_COLOR: "1",
    ...(spec.model ? { AGENT_MODEL: spec.model } : {}),
    ...(spec.effort ? { AGENT_EFFORT: spec.effort } : {}),
    ...(spec.askMode ? { ASK_MODE: spec.askMode } : {}),
  };
  const child = spawn(path.join(ROOT, "node_modules", ".bin", "tsx"), ["src/index.ts"], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
  const label = styleText(["bold", color], `[${spec.name}]`);
  const entry = { spec, child, label };
  running.push(entry);
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream! }).on("line", (line) => console.log(`${label} ${line}`));
  }
  child.on("exit", (code) => {
    console.log(`${label} exited${code ? ` with code ${code}` : ""}.`);
    running.splice(running.indexOf(entry), 1);
    if (!running.length) process.exit(0);
  });
}

console.log(
  `Starting ${specs.length} agents: ${specs.map((s) => `${s.name}${s.team ? ` (team ${s.team})` : " (alone)"}`).join(", ")}.\n` +
    'Type "@name message", "@team message", or "@all message"; a message with no @ goes to everyone. /quit stops them all.',
);
for (const [i, spec] of specs.entries()) {
  // Stagger logins so the server isn't hit by several connections at once.
  if (i) await new Promise((r) => setTimeout(r, 3_000));
  start(spec, COLORS[i % COLORS.length]!);
}

const terminal = readline.createInterface({ input: process.stdin });
terminal.on("line", (input) => {
  const line = input.trim();
  if (!line) return;
  const addressed = line.match(/^@(\w+)\s+([\s\S]+)$/);
  const target = addressed?.[1]?.toLowerCase();
  const text = addressed ? addressed[2]! : line;
  const recipients = !target || ["all", "everyone"].includes(target)
    ? running
    : running.filter((r) => r.spec.name.toLowerCase() === target || r.spec.team?.toLowerCase() === target);
  if (!recipients.length) {
    console.log(`No running agent or team called "${addressed?.[1]}".`);
    return;
  }
  // Forward the line with its address, so each agent knows who else got it.
  for (const r of recipients) r.child.stdin?.write(`${line}\n`);
  if (!target && text === "/quit") setTimeout(() => process.exit(0), 5_000);
});

// Ctrl+C reaches the agents too (same terminal); each has already saved its conversation.
process.on("SIGINT", () => {
  console.log("Stopping agents...");
  setTimeout(() => process.exit(0), 5_000);
});
