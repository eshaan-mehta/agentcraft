import type { Bot } from "mineflayer";
import { isSupervisor, teamPrefix } from "./brain/routing.js";
import { log } from "./log.js";

/** Splits text into lines of at most `limit` characters, breaking between words. */
function wrap(text: string, limit: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    // A leading slash would run the line as a server command.
    let rest = paragraph.trim().replace(/^\/+/, "");
    while (rest) {
      let cut = rest.length <= limit ? rest.length : rest.lastIndexOf(" ", limit);
      if (cut <= 0) cut = limit;
      const line = rest.slice(0, cut).trim();
      if (line) lines.push(line);
      rest = rest.slice(cut).trim();
    }
  }
  return lines;
}

/** Sends text to in-game chat (where the supervisor reads it). Minecraft caps lines at 256 characters. */
export function say(bot: Bot, text: string) {
  for (const line of wrap(text, 250)) {
    bot.chat(line);
    log.outgoing(line);
  }
}

/**
 * Sends a side-channel update (like the agent's plan) as a private message to each
 * online supervisor, so it shows apart from normal chat (gray italics). If no
 * supervisors are configured, it goes to every other player online except other
 * agents. The terminal already shows the same information, so nothing is printed here.
 */
export function narrate(bot: Bot, text: string) {
  const recipients = Object.keys(bot.players).filter(isSupervisor);
  if (!recipients.length) return;
  // "/tell name " takes up part of the 256-character limit.
  for (const line of wrap(text, 200)) for (const name of recipients) bot.whisper(name, line);
  log.raw("narrate", { text, to: recipients });
}

/** Sends a teammate a private message they'll recognize as coming from their team. */
export function messageTeammate(bot: Bot, to: string, text: string, expectsReply: boolean) {
  for (const line of wrap(text, 190)) bot.whisper(to, `${teamPrefix(expectsReply)} ${line}`);
}
