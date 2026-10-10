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
 * Whether a public chat message from the supervisor is meant for this agent.
 * "Bob, ..." / "Bob: ..." / "@Bob ..." goes to Bob only; the same with a team name
 * goes to that team; "all, ..." / "@everyone ..." or no address goes to every agent.
 * Returns null if it's addressed to someone else.
 */
export function addressedToMe(message: string): Addressed | null {
  const me = config.mc.username.toLowerCase();
  const alone = team.others.length === 0;
  const match = message.match(/^\s*@([A-Za-z0-9_]{1,16})[\s,:]+([\s\S]*)$/) ?? message.match(/^\s*([A-Za-z0-9_]{1,16})\s*[,:]\s*([\s\S]*)$/);
  const everyone: Addressed = { text: message.trim(), audience: alone ? "you" : "everyone" };
  if (!match) return everyone;

  const word = match[1]!.toLowerCase();
  const rest = match[2]!.trim();
  const agentNames = new Set([me, ...team.roster.map((a) => a.name.toLowerCase())]);
  const teamNames = new Set(team.roster.map((a) => a.team?.toLowerCase()).filter((t): t is string => Boolean(t)));

  if (word === me) return { text: rest, audience: "you" };
  if (team.name && word === team.name.toLowerCase()) return { text: rest, audience: `your team (${team.name})` };
  if (EVERYONE.has(word)) return { text: rest, audience: alone ? "you" : "everyone" };
  if (agentNames.has(word) || teamNames.has(word)) return null; // someone else's
  return everyone; // "wood, please" isn't an address
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
