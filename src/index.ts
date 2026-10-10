import path from "node:path";
import readline from "node:readline";
import { createApi } from "./api.js";
import { Body } from "./body/body.js";
import { connect } from "./body/bot.js";
import { Motor } from "./body/motor.js";
import { Navigator } from "./body/navigation.js";
import { Agent } from "./brain/agent.js";
import { addressedToMe, isSupervisor, teammateMessage } from "./brain/routing.js";
import { SessionStore } from "./brain/session.js";
import { createTools } from "./brain/tools.js";
import { say } from "./comms.js";
import { ASK_MODES, config, team, type AskMode } from "./config.js";
import { errorText } from "./errors.js";
import { log } from "./log.js";
import { startRuntime } from "./runtime.js";
import { SkillLibrary } from "./skills/library.js";
import { Survival } from "./survival/reflexes.js";
import { Knowledge } from "./world/knowledge.js";
import { Memory } from "./world/memory.js";
import { formatPos } from "./world/perception.js";

// Mineflayer plugins occasionally reject promises nobody awaits; log instead of crashing.
process.on("unhandledRejection", (err) => log.error(`Unhandled error: ${String(err)}`, err));
// Likewise for errors thrown in callbacks and unhandled 'error' events: one failing
// piece shouldn't take the agent offline. (If the connection itself drops, the
// "end" handler below exits, and the launcher restarts the agent.)
process.on("uncaughtException", (err) => log.error(`Unexpected error, still running: ${errorText(err)}`, err));

log.info(`Connecting to ${config.mc.host}:${config.mc.port} as ${config.mc.username} (Minecraft ${config.mc.version})...`);
const { bot, movements } = await connect();

// Body and senses
const body = new Body(bot);
const nav = new Navigator(bot, movements);
const memory = new Memory(config.knowledgeDir, config.mc.username);
const skills = new SkillLibrary(path.join(config.knowledgeDir, "skills"), config.mc.username);
const motor = new Motor(bot, nav, memory);
const knowledge = new Knowledge(bot);
const api = createApi({ bot, motor, knowledge, memory });

// Mind
const agent = new Agent({ bot, body, memory, skills, session: new SessionStore(path.join(config.dataDir, "conversation.json")) });
agent.setTools(createTools({ bot, api, knowledge, memory, skills, executive: agent }));
log.info(agent.restore());
const survival = new Survival(bot, body, motor, (signal) => api.buildShelter!.run([], signal) as Promise<string>);
survival.start(agent);
agent.resumeIfInterrupted();

log.info(`Joined at ${formatPos(bot.entity.position)}. Model ${config.claude.model}, effort ${config.claude.effort}, ask mode "${config.askMode}".`);
log.info(`Survival reflexes on; self-directed survival turns ${config.autonomy ? "on" : "off"}. ${skills.list().length} saved skills.`);
if (team.others.length) {
  log.info(team.name ? `Team "${team.name}"${team.mates.length ? ` with ${team.mates.join(", ")}` : " (no teammates online yet)"}; sharing knowledge in ${config.knowledgeDir}.` : `Working alone; other agents: ${team.others.join(", ")}.`);
}
log.info(`Transcript: ${log.transcriptPath}`);
log.info("Give instructions in game chat or here. Commands: /stop /ask <often|stuck|rarely> /plan /skills /memory /usage /reset /quit");

// Public chat can be addressed ("Bob, ..." / "@red ..."); private messages are for this
// agent alone. Other agents' messages are never instructions, but teammates' tagged
// private messages are delivered as team messages.
bot.on("chat", (username, message) => {
  if (!isSupervisor(username)) return;
  const addressed = addressedToMe(message);
  if (addressed) agent.receive(username, addressed.text, addressed.audience);
});
bot.on("whisper", (username, message) => {
  const fromMate = teammateMessage(username, message);
  if (fromMate) return agent.receiveTeammate(username, fromMate.text, fromMate.expectsReply);
  if (isSupervisor(username)) agent.receive(username, message, "you, privately");
});

bot.on("kicked", (reason) => log.error(`Kicked from the server: ${JSON.stringify(reason)}`));
bot.on("error", (err) => log.error(`Connection error: ${err.message}`, err));
bot.on("end", (reason) => {
  log.error(`Disconnected (${reason}). Exiting.`);
  process.exit(1);
});

/**
 * A line typed in the terminal (or sent from the dashboard): a command or a message for
 * the agent. Lines are addressed like chat ("@Bob ...", "@red ...", or no address),
 * which matters when the multi-agent launcher forwards one line to several agents.
 */
function handleLine(input: string, from = "console") {
  const addressed = input.trim() ? addressedToMe(input.trim()) : null;
  if (!addressed) return;
  const line = addressed.text;
  const [command, arg] = line.split(/\s+/, 2);
  switch (command) {
    case "/quit":
      bot.quit();
      process.exit(0);
    case "/stop":
      agent.interrupt();
      return;
    case "/ask":
      if (ASK_MODES.includes(arg as AskMode)) agent.setAskMode(arg as AskMode);
      else log.info(`Ask mode is "${config.askMode}". Use /ask often, /ask stuck, or /ask rarely.`);
      return;
    case "/plan":
      agent.showPlan();
      return;
    case "/skills":
      log.info(`Saved skills:\n${skills.describe()}`);
      return;
    case "/memory":
      log.info(memory.recall("") || "Nothing remembered yet.");
      return;
    case "/usage":
      log.info(agent.usageSummary());
      return;
    case "/reset":
      agent.reset();
      log.info("Conversation cleared (and the saved copy deleted). Memory and skills are kept.");
      return;
    default:
      agent.receive(from, line, addressed.audience);
  }
}

const terminal = readline.createInterface({ input: process.stdin });
terminal.on("line", (input) => handleLine(input));

// The dashboard sees this agent through a status file and talks to it through an inbox.
// Its inbox is this agent's alone, so each line is addressed to it ("@Name ...").
startRuntime({
  bot,
  agent,
  transcriptPath: log.transcriptPath,
  onLine: (text) => handleLine(`@${config.mc.username} ${text}`, "dashboard"),
  onError: (message) => log.warn(message),
});

say(bot, "Online. Tell me what you need.");
