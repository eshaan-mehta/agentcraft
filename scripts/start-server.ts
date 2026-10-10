// Starts the local Minecraft server set up by `npm run server:setup`. The server
// console stays interactive: type commands like `op YourName` or `time set day`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SERVER_DIR, SERVER_INFO, type ServerInfo, findJava, javaInstallHint } from "./java.js";

if (!fs.existsSync(path.join(SERVER_DIR, "server.jar")) || !fs.existsSync(SERVER_INFO)) {
  console.error("No server found. Run: npm run server:setup");
  process.exit(1);
}
const info = JSON.parse(fs.readFileSync(SERVER_INFO, "utf8")) as ServerInfo;
const java = findJava(info.javaMajor);
if (!java) {
  console.error(`Minecraft ${info.version} needs Java ${info.javaMajor} or newer. ${javaInstallHint(info.javaMajor)}`);
  process.exit(1);
}

console.log(`Starting Minecraft ${info.version} server with Java ${java.major}...`);
const opsFile = path.join(SERVER_DIR, "ops.json");
const ops = fs.existsSync(opsFile) ? (JSON.parse(fs.readFileSync(opsFile, "utf8")) as unknown[]) : [];
if (ops.length === 0) {
  console.log("Tip: nobody is an operator yet. Type `op YourMinecraftName` here once to use commands like /gamemode and /spectate.");
}
const server = spawn(java.path, ["-Xms1G", "-Xmx2G", "-jar", "server.jar", "nogui"], {
  cwd: SERVER_DIR,
  stdio: "inherit",
});
server.on("exit", (code) => process.exit(code ?? 0));
// Ctrl+C reaches the Java process directly (same terminal), which saves the world and exits.
process.on("SIGINT", () => {});
