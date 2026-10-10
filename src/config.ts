try {
  process.loadEnvFile();
} catch {
  // No .env file - fall back to the real environment.
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const ASK_MODES = ["often", "stuck", "rarely"] as const;
export type AskMode = (typeof ASK_MODES)[number];

function env(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")} (got "${value}")`);
  }
  return value as T;
}

export interface RosterEntry {
  name: string;
  /** null means the agent works alone. */
  team: string | null;
}

/** Parses "Claude:red,Bob:red,Eve" (name, optional team) into roster entries. */
function parseRoster(value: string): RosterEntry[] {
  return list(value).map((entry) => {
    const [name, team] = entry.split(":").map((part) => part.trim());
    return { name: name!, team: team || null };
  });
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  mc: {
    // 127.0.0.1 rather than "localhost": Node may resolve localhost to ::1, and the
    // bundled server config only listens on IPv4 loopback.
    host: env("MC_HOST", "127.0.0.1"),
    port: Number(env("MC_PORT", "25565")),
    version: env("MC_VERSION", "1.21.11"),
    username: env("BOT_USERNAME", "Claude"),
    auth: oneOf("MC_AUTH", env("MC_AUTH", "offline"), ["offline", "microsoft"] as const),
  },
  claude: {
    model: env("AGENT_MODEL", "claude-sonnet-5-5"),
    effort: oneOf("AGENT_EFFORT", env("AGENT_EFFORT", "medium"), EFFORTS),
  },
  // Names whose chat counts as instructions. Empty means any player's chat does; the
  // world is meant to have no players besides the bot, so that's usually just you.
  supervisors: list(env("SUPERVISORS", env("ALLOWED_PLAYERS", ""))),
  // How readily the bot stops to ask for guidance. Changeable at runtime with /ask.
  askMode: oneOf("ASK_MODE", env("ASK_MODE", "stuck"), ASK_MODES),
  // How long ask_supervisor waits for an answer before carrying on with its best guess.
  // Survival reflexes always run. This controls whether survival needs (night is
  // coming, no food, just died) also wake Claude when it has no task, which costs tokens.
  autonomy: oneOf("SURVIVAL_AUTONOMY", env("SURVIVAL_AUTONOMY", "on"), ["on", "off"] as const) === "on",
  // Post the agent's plan (and changes to it) to the supervisor as private messages in game.
  planInChat: oneOf("PLAN_IN_CHAT", env("PLAN_IN_CHAT", "on"), ["on", "off"] as const) === "on",
  // Restore the previous conversation on startup (saved after every step).
  resume: oneOf("RESUME_SESSION", env("RESUME_SESSION", "on"), ["on", "off"] as const) === "on",
  // Longest a single run_code script may run.
  maxScriptSeconds: Number(env("MAX_SCRIPT_SECONDS", "180")),
  logDir: env("LOG_DIR", "logs"),
  // This agent's own state: its saved conversation.
  dataDir: env("DATA_DIR", "data"),
  // Memory and saved skills. Teammates point this at the same folder to share them.
  knowledgeDir: env("KNOWLEDGE_DIR", env("DATA_DIR", "data")),
  // Where running agents publish their status for the dashboard and read messages sent
  // from it. Every agent (and the dashboard) must use the same folder.
  runtimeDir: env("RUNTIME_DIR", "runtime"),
};

// Every agent in the world, set by the multi-agent launcher. Empty when running alone.
const roster = parseRoster(env("AGENT_ROSTER", ""));
const me = roster.find((a) => a.name.toLowerCase() === config.mc.username.toLowerCase());

export const team = {
  /** This agent's team, or null if it works alone. */
  name: me?.team ?? null,
  /** Other agents on the same team. */
  mates: roster.filter((a) => a !== me && me?.team && a.team === me.team).map((a) => a.name),
  /** Every other agent in the world, teammate or not. Their chat is never taken as instructions. */
  others: roster.filter((a) => a !== me).map((a) => a.name),
  /** All agents, for recognizing who a chat message is addressed to. */
  roster,
  /** Who splits up team jobs: the first teammate listed in the roster. */
  lead: me?.team ? (roster.find((a) => a.team === me.team)?.name ?? null) : null,
};
