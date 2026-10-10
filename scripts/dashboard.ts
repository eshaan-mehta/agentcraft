// A local web dashboard for the agents: what they've cost, what they're thinking and
// doing, and a chat to talk to each one. It works with `npm start` and with
// `npm run agents`, and shows agents that aren't running from their past transcripts.
//
//   npm run dashboard        then open http://127.0.0.1:4321 (DASHBOARD_PORT)
//
// It only listens on 127.0.0.1. Live status and messages go through runtime/agents/
// (see src/runtime.ts); costs and history come from the transcripts in logs/.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import { readRegistry, sendToInbox, type RegistryEntry } from "./dashboard-registry.js";
import { localDay, realPath, TranscriptIndex, type FileState, type Plan, type TranscriptEvent } from "./dashboard-transcripts.js";
import { addTotals, blankTotals, type Totals } from "./transcripts.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_DIR = path.join(ROOT, "dashboard");
const HOST = "127.0.0.1";
const PORT = Number(process.env.DASHBOARD_PORT?.trim() || 4321);
const MAX_MESSAGE = 4_000;

// ---- What the agents are doing -----------------------------------------------------

const index = new TranscriptIndex(config.logDir, (file, event) => broadcastEvent(agentOf(file), event));
/** Transcripts directly in logs/ that a running agent said are its own. */
const claimed = new Map<string, string>();
let registry: RegistryEntry[] = [];

/** Which agent wrote a transcript: its folder in logs/, else the agent that claimed it, else the name it logged in with. */
function agentOf(file: FileState): string {
  return file.dirAgent ?? claimed.get(file.file) ?? file.username ?? config.mc.username;
}

function refreshRegistry() {
  registry = readRegistry(config.runtimeDir);
  for (const entry of registry) {
    if (!path.isAbsolute(entry.transcriptPath)) continue;
    index.follow(entry.transcriptPath, entry.name);
    claimed.set(realPath(entry.transcriptPath), entry.name);
  }
}

interface AgentRow {
  name: string;
  online: boolean;
  busy: boolean;
  asking: boolean;
  team: string | null;
  model: string | null;
  effort: string | null;
  askMode: string | null;
  /** Null when offline. */
  live: RegistryEntry["live"];
  /** The live plan when online; the last one logged when not. */
  plan: Plan | null;
  usage: { allTime: Totals; today: Totals; session: Totals };
  sessions: number;
  startedAt: string | null;
  lastActivity: string | null;
}

function filesOf(name: string): FileState[] {
  return [...index.files.values()].filter((f) => agentOf(f) === name).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function overview() {
  refreshRegistry();
  const today = localDay(new Date());
  const names = new Set([...registry.map((e) => e.name), ...[...index.files.values()].map(agentOf)]);
  const agents: AgentRow[] = [];
  const allTime = blankTotals();
  const todayTotals = blankTotals();
  for (const name of names) {
    const files = filesOf(name);
    const entry = registry.find((e) => e.name === name);
    const online = entry?.online ?? false;
    const newest = files.at(-1);
    // "This session" is the running one, or the most recent.
    const sessionFile = (online && files.find((f) => f.file === realPath(entry!.transcriptPath))) || newest;
    const row: AgentRow = {
      name,
      online,
      busy: online && Boolean(entry?.busy),
      asking: online && Boolean(entry?.asking),
      team: entry ? entry.team : (files.findLast((f) => f.team !== undefined)?.team ?? null),
      model: entry?.model ?? files.findLast((f) => f.model)?.model ?? null,
      effort: entry?.effort ?? null,
      askMode: entry?.askMode ?? null,
      live: online ? (entry?.live ?? null) : null,
      plan: online ? (entry?.plan ?? null) : (files.findLast((f) => f.plan)?.plan ?? null),
      usage: { allTime: blankTotals(), today: blankTotals(), session: { ...(sessionFile?.usage ?? blankTotals()) } },
      sessions: files.length,
      startedAt: online ? (entry?.startedAt ?? null) : null,
      lastActivity: files.reduce<string | null>((latest, f) => (f.lastT && (!latest || f.lastT > latest) ? f.lastT : latest), null),
    };
    for (const f of files) {
      addTotals(row.usage.allTime, f.usage);
      addTotals(row.usage.today, f.days.get(today));
    }
    addTotals(allTime, row.usage.allTime);
    addTotals(todayTotals, row.usage.today);
    agents.push(row);
  }
  agents.sort((a, b) => Number(b.online) - Number(a.online) || (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "") || a.name.localeCompare(b.name));
  return { generatedAt: new Date().toISOString(), today, totals: { allTime, today: todayTotals }, agents };
}

// ---- Live updates (Server-Sent Events) -------------------------------------------------

interface Client {
  res: http.ServerResponse;
  /** Only this agent's events, or every agent's. */
  agent: string | null;
}
const clients = new Set<Client>();

function send(res: http.ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastEvent(agent: string, event: TranscriptEvent) {
  for (const client of clients) if (!client.agent || client.agent === agent) send(client.res, "transcript", { agent, ...event });
}

function openStream(req: http.IncomingMessage, res: http.ServerResponse, agent: string | null) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write("retry: 2000\n\n");
  const client = { res, agent };
  clients.add(client);
  send(res, "overview", overview());
  req.on("close", () => clients.delete(client));
  res.on("error", () => clients.delete(client));
}

/** Runs `fn` now and then; a failure is logged instead of stopping the dashboard. */
function every(ms: number, fn: () => void) {
  return setInterval(() => {
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
  }, ms);
}

// Watching is fast; polling catches whatever watching misses (and new folders).
let watcher: fs.FSWatcher | null = null;
let pendingScan: NodeJS.Timeout | null = null;
function watchLogs() {
  if (watcher || !fs.existsSync(config.logDir)) return;
  try {
    watcher = fs.watch(config.logDir, { recursive: true }, () => {
      pendingScan ??= setTimeout(() => {
        pendingScan = null;
        try {
          index.scan();
        } catch (err) {
          console.error(err);
        }
      }, 50);
    });
    watcher.on("error", () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    watcher = null;
  }
}

every(1_000, () => {
  watchLogs();
  index.scan();
});
every(2_000, () => {
  if (!clients.size) return;
  const data = overview();
  for (const client of clients) send(client.res, "overview", data);
});
// A comment line now and then keeps idle connections from being dropped.
every(15_000, () => {
  for (const client of clients) client.res.write(": ping\n\n");
});

// ---- HTTP ------------------------------------------------------------------------------

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveStatic(res: http.ServerResponse, urlPath: string) {
  const file = path.resolve(STATIC_DIR, `.${urlPath === "/" ? "/index.html" : urlPath}`);
  const type = CONTENT_TYPES[path.extname(file)];
  if (!file.startsWith(STATIC_DIR + path.sep) || !type || !fs.existsSync(file)) return json(res, 404, { error: "Not found" });
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    // Only our own scripts and styles: transcript text can never become markup or code.
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(fs.readFileSync(file));
}

function readBody(req: http.IncomingMessage, limit = 16_384): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** Requests from this page only: guards against other web pages and DNS rebinding. */
function trusted(req: http.IncomingMessage): boolean {
  const allowed = [`${HOST}:${PORT}`, `localhost:${PORT}`];
  if (!allowed.includes(req.headers.host ?? "")) return false;
  const origin = req.headers.origin;
  return !origin || allowed.some((host) => origin === `http://${host}`);
}

async function postMessage(req: http.IncomingMessage, res: http.ServerResponse, name: string) {
  // A JSON body means browsers send a CORS preflight first, which other sites can't pass.
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "Send JSON: {\"text\": \"...\"}" });
  let text: unknown;
  try {
    text = (JSON.parse(await readBody(req)) as { text?: unknown }).text;
  } catch {
    return json(res, 400, { error: "Send JSON: {\"text\": \"...\"}" });
  }
  if (typeof text !== "string" || !text.trim()) return json(res, 400, { error: "The message is empty." });
  if (text.length > MAX_MESSAGE) return json(res, 400, { error: `Messages are limited to ${MAX_MESSAGE} characters.` });
  refreshRegistry();
  const entry = registry.find((e) => e.name === name);
  if (!entry && !filesOf(name).length) return json(res, 404, { error: `No agent called ${name}.` });
  if (!entry?.online) return json(res, 409, { error: `${name} isn't running, so it can't receive messages.` });
  try {
    sendToInbox(entry, text.trim());
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
  json(res, 200, { ok: true });
}

function getEvents(res: http.ServerResponse, name: string, params: URLSearchParams) {
  index.scan();
  const files = filesOf(name);
  if (!files.length && !registry.some((e) => e.name === name)) return json(res, 404, { error: `No agent called ${name}.` });
  const limit = Math.min(Math.max(Number(params.get("limit")) || 300, 1), 2_000);
  const { events, more } = index.history(files, limit, params.get("before") ?? undefined);
  json(res, 200, { agent: name, events, more });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  if (!trusted(req)) return json(res, 403, { error: "Forbidden" });
  const agentRoute = url.pathname.match(/^\/api\/agents\/([^/]+)\/(events|message)$/);
  void (async () => {
    const name = agentRoute ? decodeURIComponent(agentRoute[1]!) : "";
    if (req.method === "GET" && url.pathname === "/api/overview") return json(res, 200, overview());
    if (req.method === "GET" && url.pathname === "/api/stream") return openStream(req, res, url.searchParams.get("agent"));
    if (req.method === "GET" && agentRoute?.[2] === "events") return getEvents(res, name, url.searchParams);
    if (req.method === "POST" && agentRoute?.[2] === "message") return postMessage(req, res, name);
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);
    json(res, 404, { error: "Not found" });
  })().catch((err: unknown) => {
    if (err instanceof URIError) return json(res, 400, { error: "Bad agent name in the URL." });
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: "Internal error" });
    else res.end();
  });
});

refreshRegistry();
index.scan(false);
watchLogs();
server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${PORT} is in use. Set DASHBOARD_PORT to another port.` : err.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`Dashboard: http://${HOST}:${PORT}  (local only; reading ${path.resolve(config.logDir)} and ${path.resolve(config.runtimeDir)})`);
});
