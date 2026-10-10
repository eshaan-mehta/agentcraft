// Downloads the official Minecraft server for MC_VERSION and configures it for
// local agent testing. Run with: npm run server:setup [-- --accept-eula]
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { config } from "../src/config.js";
import { SERVER_DIR, SERVER_INFO, type ServerInfo, findJava, javaInstallHint } from "./java.js";

const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const EULA_URL = "https://aka.ms/MinecraftEULA";

// Tuned for a local test world with a bot:
// - online-mode=false lets the bot join without its own Microsoft account. That also
//   means anyone who can reach the server can join under any name, so it only
//   listens on 127.0.0.1.
// - spawn-protection=0 so the bot (not an operator) can dig near spawn.
// - allow-flight=true avoids "flying is not enabled" kicks when the bot's movement
//   looks odd to the server's anti-cheat.
const PROPERTIES = {
  "online-mode": "false",
  "enforce-secure-profile": "false",
  "server-ip": "127.0.0.1",
  "server-port": String(config.mc.port),
  "spawn-protection": "0",
  "allow-flight": "true",
  // No watchdog: a tick that stalls (say, the disk freezing for a minute during a save)
  // means some lag instead of the server killing itself.
  "max-tick-time": "-1",
  motd: "Claude agent test world",
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return (await response.json()) as T;
}

async function downloadServerJar(version: string): Promise<number> {
  const manifest = await fetchJson<{ versions: { id: string; url: string }[] }>(MANIFEST);
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) throw new Error(`Minecraft version ${version} not found in Mojang's version manifest.`);
  const meta = await fetchJson<{
    downloads: { server?: { url: string; sha1: string } };
    javaVersion?: { majorVersion: number };
  }>(entry.url);
  const server = meta.downloads.server;
  if (!server) throw new Error(`Version ${version} has no server download.`);

  const jarPath = path.join(SERVER_DIR, "server.jar");
  const sha1 = (data: Buffer) => createHash("sha1").update(data).digest("hex");
  if (fs.existsSync(jarPath) && sha1(fs.readFileSync(jarPath)) === server.sha1) {
    console.log(`server.jar for ${version} is already downloaded.`);
  } else {
    console.log(`Downloading the Minecraft ${version} server from Mojang...`);
    const response = await fetch(server.url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (sha1(data) !== server.sha1) throw new Error("Downloaded server.jar failed its checksum.");
    fs.writeFileSync(jarPath, data);
  }
  return meta.javaVersion?.majorVersion ?? 21;
}

function writeProperties() {
  const file = path.join(SERVER_DIR, "server.properties");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  const remaining = new Map(Object.entries(PROPERTIES));
  const updated = lines.map((line) => {
    const key = line.split("=")[0]!;
    const value = remaining.get(key);
    if (value === undefined) return line;
    remaining.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of remaining) updated.push(`${key}=${value}`);
  fs.writeFileSync(file, updated.join("\n").trimEnd() + "\n");
}

async function acceptEula(): Promise<boolean> {
  const file = path.join(SERVER_DIR, "eula.txt");
  if (fs.existsSync(file) && /eula=true/.test(fs.readFileSync(file, "utf8"))) return true;

  let accepted = process.argv.includes("--accept-eula");
  if (!accepted && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Running a Minecraft server requires accepting the Minecraft EULA (${EULA_URL}).\nDo you accept it? [y/N] `);
    rl.close();
    accepted = /^y(es)?$/i.test(answer.trim());
  }
  if (accepted) fs.writeFileSync(file, `# Accepted via setup-server on ${new Date().toISOString()} (${EULA_URL})\neula=true\n`);
  return accepted;
}

fs.mkdirSync(SERVER_DIR, { recursive: true });
const javaMajor = await downloadServerJar(config.mc.version);
fs.writeFileSync(SERVER_INFO, JSON.stringify({ version: config.mc.version, javaMajor } satisfies ServerInfo, null, 2));
writeProperties();
console.log(`Wrote ${path.join(SERVER_DIR, "server.properties")}.`);

if (!(await acceptEula())) {
  console.log(`\nEULA not accepted, so the server won't start. Read ${EULA_URL}, then rerun with: npm run server:setup -- --accept-eula`);
  process.exit(1);
}

const java = findJava(javaMajor);
if (java) {
  console.log(`\nReady. Java ${java.major} found at ${java.path}. Start the server with: npm run server`);
} else {
  console.log(`\nMinecraft ${config.mc.version} needs Java ${javaMajor} or newer, which wasn't found. ${javaInstallHint(javaMajor)}`);
}
