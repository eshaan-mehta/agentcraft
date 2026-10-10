// Who a chat message is for, when several agents share a world.
import { config, team } from "../config.js";

const EVERYONE = new Set(["all", "everyone", "everybody"]);

/** A message for this agent: its text without the address, and who it was addressed to. */
export interface Addressed {
  text: string;
  /** "you", "your team (red)", or "everyone": tells the agent whether to coordinate. */
  audience: string;
}

/** Whether a player's messages count as instructions. Other agents never do. */
export function isSupervisor(username: string): boolean {
  if (username.toLowerCase() === config.mc.username.toLowerCase()) return false;
  if (team.others.some((name) => name.toLowerCase() === username.toLowerCase())) return false;
  return config.supervisors.length === 0 || config.supervisors.some((name) => name.toLowerCase() === username.toLowerCase());
}

/**
 * Whether a public chat message from the supervisor is meant for this agent, judged
 * by the names it opens with. "Bob, ...", "bob ...", "@Bob ...", and "ace and bob ..."
 * go to those agents only; "@red ..." or "red, ..." to that team; "all, ...",
 * "everyone ...", or no names at all to every agent. Returns null if it's for others.
 */
export function addressedToMe(message: string): Addressed | null {
  const me = config.mc.username.toLowerCase();
  const alone = team.others.length === 0;
  const everyone: Addressed = { text: message.trim(), audience: alone ? "you" : "everyone" };
  const agents = new Map([[me, config.mc.username], ...team.roster.map((a) => [a.name.toLowerCase(), a.name] as const)]);
  const teams = new Set(team.roster.map((a) => a.team?.toLowerCase()).filter((t): t is string => Boolean(t)));

  const named: string[] = [];
  let rest = message.trim();
  for (;;) {
    const match = rest.match(/^(@?)([A-Za-z0-9_]{1,16})(\s*[,:&]|\s+and(?=\s)|(?=\s)|$)\s*/i);
    if (!match) break;
    const word = match[2]!.toLowerCase();
    // Team names are often ordinary words ("red wool..."), so they need an @ or a comma.
    const marked = Boolean(match[1]) || /[,:]/.test(match[3]!);
    if (!agents.has(word) && !EVERYONE.has(word) && !(marked && teams.has(word))) break;
    named.push(word);
    rest = rest.slice(match[0].length);
  }
  if (!named.length || named.some((n) => EVERYONE.has(n))) return everyone;

  const text = rest.trim() || message.trim();
  if (named.includes(me)) {
    const others = named.filter((n) => n !== me).map((n) => agents.get(n) ?? n);
    return { text, audience: others.length && !alone ? `you and ${others.join(", ")}` : "you" };
  }
  if (team.name && named.includes(team.name.toLowerCase())) return { text, audience: `your team (${team.name})` };
  return null; // someone else's
}

const TEAM_PREFIX = /^\[team(\?)?\]\s*([\s\S]*)$/;

/** A private message from a teammate sent with message_teammate, or null if it isn't one. */
export function teammateMessage(username: string, message: string): { text: string; expectsReply: boolean } | null {
  if (!team.mates.some((name) => name.toLowerCase() === username.toLowerCase())) return null;
  const match = message.match(TEAM_PREFIX);
  return match ? { text: match[2]!.trim(), expectsReply: Boolean(match[1]) } : null;
}

export function teamPrefix(expectsReply: boolean): string {
  return expectsReply ? "[team?]" : "[team]";
}
