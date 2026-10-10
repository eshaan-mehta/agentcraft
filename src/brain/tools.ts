import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { Bot } from "mineflayer";
import vm from "node:vm";
import { z } from "zod";
import { apiReference, type Method } from "../api.js";
import { pause } from "../body/motor.js";
import { config, team } from "../config.js";
import { ActionError } from "../errors.js";
import { log } from "../log.js";
import { runScript, type ScriptResult } from "../sandbox/host.js";
import type { SkillLibrary } from "../skills/library.js";
import { formatMaterials, type Knowledge } from "../world/knowledge.js";
import type { Memory } from "../world/memory.js";
import * as see from "../world/perception.js";

/** A tool Claude can call. `body` tools take control of the bot while they run. */
export type AgentTool = BetaRunnableTool<any> & { body: boolean };

/** What the brain provides to tools that talk to the supervisor or manage the plan. */
export interface Executive {
  ask(question: string, options: string[] | undefined, signal: AbortSignal): Promise<string>;
  /** Sends the supervisor a message without waiting for a reply. */
  tell(text: string): void;
  /** Sends a teammate (or "team") a private message; returns who got it. */
  messageTeammate(to: string, text: string, expectsReply: boolean): string;
  /** Waits for the next teammate message; returns it, or says none came. */
  waitForTeammate(seconds: number, signal: AbortSignal): Promise<string>;
  plan(goal: string, steps: { step: string; status: string }[], note?: string): void;
}

export interface ToolDeps {
  bot: Bot;
  api: Record<string, Method>;
  knowledge: Knowledge;
  memory: Memory;
  skills: SkillLibrary;
  executive: Executive;
}

const pos = { x: z.number(), y: z.number(), z: z.number() };
const optionalPos = z.object(pos).optional();

function format(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}... (${text.length - max} more chars)` : text;
}

function describeScript(result: ScriptResult): string {
  const logs = result.logs.length
    ? `\nLogs${result.logs.length > 40 ? " (last 40)" : ""}:\n${result.logs.slice(-40).join("\n")}`
    : "";
  if (result.ok) return `Finished in ${result.seconds}s (${result.calls} api calls). Returned: ${truncate(JSON.stringify(result.value), 6000)}${logs}`;
  const where = result.error?.stack ? `\n${result.error.stack}` : "";
  return `Failed after ${result.seconds}s (${result.calls} api calls): ${result.error?.code ? `[${result.error.code}] ` : ""}${result.error?.message}${where}${logs}`;
}

/** Compiles (without running) a script body to catch syntax errors before saving it. */
function checkSyntax(code: string) {
  try {
    new vm.Script(`(async (api, args, log) => {\n${code}\n})`);
  } catch (err) {
    throw new ActionError("INVALID", `That code doesn't parse: ${(err as Error).message}`);
  }
}

export function createTools({ bot, api, knowledge, memory, skills, executive }: ToolDeps): AgentTool[] {
  const tool = <S extends z.ZodObject<z.ZodRawShape>>(spec: {
    name: string;
    description: string;
    input: S;
    body?: boolean;
    run: (args: z.infer<S>, signal: AbortSignal) => unknown;
  }): AgentTool => ({
    ...betaZodTool({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.input,
      run: async (args, context) => format(await spec.run(args, context?.signal ?? new AbortController().signal)),
    }),
    body: spec.body ?? false,
  });
  const call = (method: string, args: unknown[], signal: AbortSignal) => api[method]!.run(args, signal);

  const teamTools: AgentTool[] = team.mates.length
    ? [
        tool({
          name: "message_teammate",
          description: `Send a teammate (${team.mates.join(", ")}) or the whole team a short private message: what you're taking on, a request for help, a heads-up. Set expect_reply only when you need an answer; their reply arrives as a [teammate] note.`,
          input: z.object({
            to: z.string().describe(`A teammate's name, or "team" for all of them`),
            text: z.string().max(400),
            expect_reply: z.boolean().optional(),
          }),
          run: ({ to, text, expect_reply }) => executive.messageTeammate(to, text, expect_reply ?? false),
        }),
        tool({
          name: "wait_for_teammate",
          description: "Wait for a message from a teammate, e.g. your part of a team job from the lead, or a teammate finishing their part. Returns as soon as one arrives.",
          input: z.object({ seconds: z.number().int().min(5).max(180).optional().describe("How long to wait at most (default 60)") }),
          run: ({ seconds }, signal) => executive.waitForTeammate(seconds ?? 60, signal),
        }),
      ]
    : [];

  const sandboxRun = async (code: string, args: unknown, timeoutSeconds: number | undefined, signal: AbortSignal) => {
    const result = await runScript(code, args ?? {}, {
      api,
      skills: skills.sources(),
      signal,
      timeoutMs: Math.min(timeoutSeconds ?? 120, config.maxScriptSeconds) * 1000,
      onLog: (text) => log.scriptOutput(text),
    });
    return result;
  };

  return [
    // ---- Seeing --------------------------------------------------------------
    tool({
      name: "observe",
      description: "Look around: status, inventory, armor, nearby creatures, notable blocks (logs, ores, water, lava, crafting tables, furnaces, chests, beds) with the nearest of each, and whether you're sheltered.",
      input: z.object({ radius: z.number().int().min(8).max(64).optional().describe("Scan radius (default 32)") }),
      run: async ({ radius }) => {
        await see.terrainLoaded(bot);
        return see.describeSurroundings(bot, radius ?? 32);
      },
    }),
    tool({
      name: "find_blocks",
      description:
        "Find the nearest blocks by name in the loaded world (about 150 blocks around you). Exact names like 'oak_log' or 'iron_ore' (ores include their deepslate variant), or partial like 'log' for every kind.",
      input: z.object({
        block: z.string(),
        max_distance: z.number().int().min(1).max(128).optional().describe("Search radius (default 64)"),
        count: z.number().int().min(1).max(100).optional().describe("Max results (default 10)"),
        near: optionalPos.describe("Search around this point instead of you"),
        exposed_only: z.boolean().optional().describe("Only blocks with an open face (not buried)"),
      }),
      run: async ({ block, max_distance, count, near, exposed_only }) => {
        await see.terrainLoaded(bot);
        const found = see.findBlocks(bot, block, { maxDistance: max_distance, count, near, exposedOnly: exposed_only });
        if (!found.length) return `No ${block} within ${max_distance ?? 64} blocks. Try a larger radius, or explore to load new terrain.`;
        return found.map((b) => `${b.name} at ${b.x} ${b.y} ${b.z} (${b.distance}m)`).join("\n");
      },
    }),
    tool({
      name: "find_entities",
      description: "List nearby creatures, dropped items, and objects, nearest first, with their numeric ids (for attack, interact, and scripts).",
      input: z.object({
        kind: z.enum(["hostile", "animal", "passive", "item", "player", "other"]).optional(),
        name: z.string().optional().describe("e.g. cow, zombie, or a dropped item's name"),
        max_distance: z.number().min(1).max(128).optional().describe("Default 32"),
      }),
      run: ({ kind, name, max_distance }) => {
        const found = see.findEntities(bot, { kind, name, maxDistance: max_distance });
        if (!found.length) return "Nothing matching nearby.";
        return found
          .map((e) => `#${e.id} ${e.name}${e.kind === "item" ? ` (dropped ${e.item} x${e.count})` : ` [${e.kind}]`} at ${e.x} ${e.y} ${e.z} (${e.distance}m)`)
          .join("\n");
      },
    }),
    tool({
      name: "inspect_block",
      description: "Details of one block: name, state (crop age, door open, facing...), whether it's solid or diggable, which tools harvest it, light level.",
      input: z.object(pos),
      run: (p) => see.blockInfo(bot, p),
    }),
    tool({
      name: "scan_area",
      description:
        "A text map around a point. 'surface': the top block of each column and its height relative to you (terrain, flat spots, water). 'layer': every block in one horizontal slice at height y (for building or digging plans).",
      input: z.object({
        mode: z.enum(["surface", "layer"]),
        radius: z.number().int().min(2).max(16).optional().describe("Default 8"),
        y: z.number().int().optional().describe("Height for 'layer' (default: your feet)"),
        center: optionalPos.describe("Default: you"),
      }),
      run: ({ mode, radius, y, center }) => {
        const c = center ?? bot.entity.position;
        return mode === "surface" ? see.scanSurface(bot, c, radius ?? 8) : see.scanLayer(bot, c, radius ?? 8, y ?? Math.floor(bot.entity.position.y));
      },
    }),
    tool({
      name: "can_reach",
      description: "Plan a route to a position without moving: whether it's reachable and roughly how many steps.",
      input: z.object({ x: z.number(), y: z.number().optional(), z: z.number() }),
      run: (target, signal) => call("canReach", [target], signal),
    }),

    // ---- Knowing -------------------------------------------------------------
    tool({
      name: "lookup",
      description:
        "Game facts from the official data: how to get an item (craft recipes, smelting, which blocks drop it and the tool needed, mob drops), or facts about a block or mob. With a count, also a materials plan from your current inventory: craft/smelt steps in order and the raw materials still to gather.",
      input: z.object({ name: z.string(), count: z.number().int().min(1).max(4096).optional() }),
      run: ({ name, count }) => {
        const key = see.normalizeName(name);
        if (!bot.registry.itemsByName[key]) return knowledge.info(key);
        const parts = [knowledge.howToObtain(key)];
        if (count) parts.push(formatMaterials(key, count, knowledge.materials(key, count)));
        return parts.join("\n\n");
      },
    }),

    // ---- Remembering ---------------------------------------------------------
    tool({
      name: "remember",
      description:
        "Save something that should outlast this conversation. note: a lesson or fact. order: a standing instruction from the supervisor that applies from now on. place: a named location (default: where you stand).",
      input: z.object({
        kind: z.enum(["note", "order", "place"]),
        text: z.string().describe("The note or order, or a description of the place"),
        name: z.string().optional().describe("For places: a short name like 'home' or 'iron_cave'"),
        tags: z.array(z.string()).optional(),
        position: optionalPos,
      }),
      run: ({ kind, text, name, tags, position }) => {
        if (kind === "place") {
          if (!name) throw new ActionError("INVALID", "Places need a name.");
          const where = position ?? bot.entity.position;
          memory.setWaypoint(name, where, text);
          return `Saved place "${name}" at ${see.formatPos(where)}.`;
        }
        return `Saved ${kind} #${memory.add(kind, text, tags)}.`;
      },
    }),
    tool({
      name: "recall",
      description: "Search everything remembered: notes, standing orders, named places, and what's in chests you've opened.",
      input: z.object({ query: z.string().describe("Keywords; empty string lists everything") }),
      run: ({ query }) => memory.recall(query),
    }),
    tool({
      name: "forget",
      description: "Delete a note or order by id, or a named place.",
      input: z.object({ id: z.number().int().optional(), place: z.string().optional() }),
      run: ({ id, place }) => {
        if (id !== undefined) return memory.forget(id) ? `Forgot #${id}.` : `No #${id}.`;
        if (place) return memory.removeWaypoint(place) ? `Forgot place ${place}.` : `No place ${place}.`;
        throw new ActionError("INVALID", "Give an id or a place name.");
      },
    }),

    // ---- Acting ----------------------------------------------------------------
    tool({
      name: "go_to",
      description:
        "Walk to a position, column (omit y), or remembered place, digging and bridging past obstacles unless careful. Replans around problems; fails with UNREACHABLE, STUCK, or TIMEOUT and where it got to.",
      input: z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
        place: z.string().optional().describe("A remembered place name instead of coordinates"),
        range: z.number().min(0).max(32).optional().describe("How close counts as arrived (default 1)"),
        careful: z.boolean().optional().describe("Never break or place blocks on the way"),
      }),
      body: true,
      run: ({ x, y, z: zc, place, range, careful }, signal) => {
        const target = place ? { waypoint: place, range } : { x, y, z: zc, range };
        if (!place && (x === undefined || zc === undefined)) throw new ActionError("INVALID", "Give x and z (and optionally y), or a place name.");
        return call("goTo", [target, { careful }], signal);
      },
    }),
    tool({
      name: "gather",
      description:
        "Mine a number of blocks (e.g. 16 oak_log, 'log' for any log, 'stone'), nearest and lowest first around you or a point, picking up the drops. Item names work too: 'cobblestone' mines stone, 'raw_iron' mines iron ore, 'coal' mines coal ore. Skips targets it can't reach; reports what it got and why it stopped.",
      input: z.object({
        block: z.string(),
        count: z.number().int().min(1).max(512),
        near: optionalPos.describe("Gather around this point instead of where you are"),
        radius: z.number().int().min(4).max(128).optional().describe("How far from the center to look (default 48)"),
      }),
      body: true,
      run: ({ block, count, near, radius }, signal) => call("gather", [block, count, { near, radius }], signal),
    }),
    tool({
      name: "craft",
      description:
        "Craft an item, including everything it needs in between (planks, sticks...), smelting where required, and setting up a crafting table or furnace if none is nearby. If raw materials are missing, the error lists exactly what to gather.",
      input: z.object({ item: z.string(), count: z.number().int().min(1).max(1024).optional().describe("Default 1") }),
      body: true,
      run: ({ item, count }, signal) => call("craft", [item, count ?? 1], signal),
    }),
    tool({
      name: "smelt",
      description: "Smelt items (raw_iron, sand, beef, logs for charcoal...) in a furnace, placing one if needed and adding fuel from your inventory. About 10 seconds per item.",
      input: z.object({ item: z.string().describe("The input item"), count: z.number().int().min(1).max(64).optional() }),
      body: true,
      run: ({ item, count }, signal) => call("smelt", [item, count ?? 1], signal),
    }),
    tool({
      name: "dig",
      description: "Mine one block (walking within reach) and pick up its drop.",
      input: z.object({ ...pos, require_drop: z.boolean().optional().describe("Fail instead of mining without the right tool") }),
      body: true,
      run: ({ require_drop, ...p }, signal) => call("dig", [p, { requireDrop: require_drop }], signal),
    }),
    tool({
      name: "place",
      description: "Place a block from your inventory at a position; it needs a solid neighbor. Grass and flowers in the spot are cleared.",
      input: z.object({ item: z.string(), ...pos }),
      body: true,
      run: ({ item, ...p }, signal) => call("place", [item, p], signal),
    }),
    tool({
      name: "use_block",
      description:
        "Right-click a block, optionally holding an item: open/close doors, trapdoors, and gates; flip levers; press buttons; till dirt with a hoe; plant seeds on farmland; use bone meal; fill or empty buckets. Reports the block's state after.",
      input: z.object({ ...pos, item: z.string().optional() }),
      body: true,
      run: ({ item, ...p }, signal) => call("useBlock", [p, item], signal),
    }),
    tool({
      name: "use_item",
      description: "Right-click the air with an item: throw (eggs, snowballs, ender pearls), drink, raise a shield, draw and release a bow (hold_ms ~1000).",
      input: z.object({ item: z.string().optional(), hold_ms: z.number().int().min(0).max(5000).optional() }),
      body: true,
      run: ({ item, hold_ms }, signal) => call("useItem", [item, hold_ms ?? 100], signal),
    }),
    tool({
      name: "equip",
      description: "Hold or wear an item.",
      input: z.object({ item: z.string(), slot: z.enum(["hand", "off-hand", "head", "torso", "legs", "feet"]).optional() }),
      body: true,
      run: ({ item, slot }, signal) => call("equip", [item, slot ?? "hand"], signal),
    }),
    tool({
      name: "drop_items",
      description: "Drop items on the ground (e.g. to clear inventory space).",
      input: z.object({ item: z.string(), count: z.number().int().min(1).optional().describe("Default: all") }),
      body: true,
      run: ({ item, count }, signal) => call("toss", [item, count], signal),
    }),
    tool({
      name: "eat",
      description: "Eat food (the most filling safe food if none named). Only works when not full.",
      input: z.object({ item: z.string().optional() }),
      body: true,
      run: ({ item }, signal) => call("eat", [item], signal),
    }),
    tool({
      name: "attack",
      description: "Hunt and kill creatures: the nearest of a type (e.g. cow for food, zombie), or one entity by id. Picks up what they drop.",
      input: z.object({
        name: z.string().optional(),
        id: z.number().int().optional(),
        count: z.number().int().min(1).max(32).optional().describe("How many of the type (default 1)"),
      }),
      body: true,
      run: async ({ name, id, count }, signal) => {
        if (id !== undefined) {
          const result = await call("fight", [id], signal);
          if (result === "killed") await call("collectDrops", [8], signal);
          return `Fight result: ${result}.`;
        }
        if (!name) throw new ActionError("INVALID", "Give a creature name or an entity id.");
        return call("hunt", [name, count ?? 1], signal);
      },
    }),
    tool({
      name: "interact_entity",
      description: "Right-click a creature or object, optionally holding an item: shear sheep, milk cows (bucket), breed animals (their food), feed, open a villager's trades.",
      input: z.object({ id: z.number().int().optional(), name: z.string().optional().describe("Nearest of this type, if no id"), item: z.string().optional() }),
      body: true,
      run: ({ id, name, item }, signal) => {
        const target = id ?? see.findEntities(bot, { name, maxDistance: 32 }).find((e) => e.kind !== "item")?.id;
        if (target === undefined) throw new ActionError("NOT_FOUND", `No ${name ?? "such entity"} nearby.`);
        return call("interact", [target, item], signal);
      },
    }),
    tool({
      name: "container",
      description: "List, deposit into, or withdraw from a chest or barrel (nearest within 32 unless a position is given). Deposit with no item stores everything except tools, armor, and food. Contents are remembered.",
      input: z.object({
        action: z.enum(["list", "deposit", "withdraw"]),
        item: z.string().optional(),
        count: z.number().int().min(1).optional(),
        position: optionalPos,
      }),
      body: true,
      run: ({ action, item, count, position }, signal) => call("container", [action, { pos: position, item, count }], signal),
    }),
    tool({
      name: "build_shelter",
      description: "Seal yourself into an emergency shelter where you stand: dig 3 down and cover the hole (1 block), or wall in with a roof where digging is unsafe (up to 11 blocks of dirt/cobblestone/planks).",
      input: z.object({}),
      body: true,
      run: (_args, signal) => call("buildShelter", [], signal),
    }),
    tool({
      name: "sleep_in_bed",
      description: "Sleep in the nearest bed within 32 blocks (at night). Sets your respawn point.",
      input: z.object({}),
      body: true,
      run: (_args, signal) => call("sleep", [], signal),
    }),
    tool({
      name: "explore",
      description: "Travel in a direction to find new terrain and resources (loads new chunks), detouring around obstacles; reports what's around on arrival.",
      input: z.object({
        direction: z.enum(["north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"]),
        distance: z.number().int().min(16).max(512).optional().describe("Default 64"),
      }),
      body: true,
      run: ({ direction, distance }, signal) => call("explore", [direction, distance ?? 64], signal),
    }),
    tool({
      name: "wait",
      description: "Wait for something to happen (crops to grow, a furnace, daylight).",
      input: z.object({ seconds: z.number().min(1).max(120) }),
      run: async ({ seconds }, signal) => {
        await pause(seconds * 1000, signal);
        return `Waited ${seconds}s. ${see.statusLine(bot)}`;
      },
    }),

    // ---- Programming -------------------------------------------------------------
    tool({
      name: "run_code",
      description: `Run JavaScript that controls the bot, for anything the other tools don't cover or for loops and conditional logic. It runs sandboxed, with no file, network, or Node access. Its only capability is the api object below. The code is the body of an async function (api, args, log). Every api call returns a Promise, so always await it: \`const { position } = await api.status();\` (without await you get a Promise, not data). Failures throw Errors with a .code. Return a JSON summary; log() progress. Saved skills: await api.skill(name, args).

API reference:
${apiReference(api)}`,
      input: z.object({
        purpose: z.string().describe("One line: what this script does"),
        code: z.string(),
        args: z.record(z.string(), z.unknown()).optional().describe("Passed to the script as `args`"),
        timeout_seconds: z.number().int().min(5).max(600).optional().describe(`Default 120, max ${config.maxScriptSeconds}`),
      }),
      body: true,
      run: async ({ purpose, code, args, timeout_seconds }, signal) => {
        log.script(purpose, code);
        const result = await sandboxRun(code, args, timeout_seconds, signal);
        const text = describeScript(result);
        if (!result.ok) throw new ActionError("FAILED", text);
        return text;
      },
    }),
    tool({
      name: "save_skill",
      description:
        "Save working script code as a named, reusable skill (persists across sessions). Write it to take its inputs from `args`, so it generalizes. Saving an existing name replaces it.",
      input: z.object({
        name: z.string().describe("camelCase, e.g. farmWheat"),
        description: z.string().describe("What it does and when to use it"),
        params: z.string().describe('The args it expects, e.g. "{ count: number, near?: {x,y,z} }", or "none"'),
        code: z.string(),
      }),
      run: ({ name, description, params, code }) => {
        checkSyntax(code);
        skills.save(name, description, params, code);
        return `Saved skill ${name}. Run it with run_skill, or api.skill("${name}", args) inside scripts.`;
      },
    }),
    tool({
      name: "run_skill",
      description: "Run a saved skill with arguments.",
      input: z.object({
        name: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        timeout_seconds: z.number().int().min(5).max(600).optional(),
      }),
      body: true,
      run: async ({ name, args, timeout_seconds }, signal) => {
        skills.get(name); // fails clearly if it doesn't exist
        const result = await sandboxRun(`return await api.skill(${JSON.stringify(name)}, args);`, args, timeout_seconds, signal);
        skills.recordRun(name, result.ok);
        const text = describeScript(result);
        if (!result.ok) throw new ActionError("FAILED", text);
        return text;
      },
    }),
    tool({
      name: "list_skills",
      description: "List saved skills, or show one skill's code.",
      input: z.object({ show: z.string().optional().describe("A skill name to show its code") }),
      run: ({ show }) => {
        if (!show) return skills.describe();
        const { meta, code } = skills.get(show);
        return `${meta.name}(args: ${meta.params}): ${meta.description}\n\n${code}`;
      },
    }),
    tool({
      name: "delete_skill",
      description: "Delete a saved skill that's broken or obsolete.",
      input: z.object({ name: z.string() }),
      run: ({ name }) => (skills.remove(name) ? `Deleted ${name}.` : `No skill ${name}.`),
    }),

    // ---- Managing the work -------------------------------------------------------
    tool({
      name: "update_plan",
      description:
        "Set or update the plan for the current goal: an ordered list of short steps with a status each, plus an optional one-line note on what you're thinking or why the plan changed. The supervisor sees it in game chat and the terminal. Update it whenever a step finishes, changes, or gets blocked.",
      input: z.object({
        goal: z.string(),
        steps: z.array(z.object({ step: z.string().describe("A few words"), status: z.enum(["todo", "doing", "done", "blocked", "skipped"]) })).min(1),
        note: z.string().optional().describe("One line: your current thinking, or why the plan changed"),
      }),
      run: ({ goal, steps, note }) => {
        executive.plan(goal, steps, note);
        return "Plan updated.";
      },
    }),
    tool({
      name: "ask_supervisor",
      description: `Ask the supervisor a question and wait for the answer (up to ${config.askTimeoutMinutes} minutes, after which you carry on with your best judgment). Say what you tried, and offer concrete options when you can.`,
      input: z.object({ question: z.string(), options: z.array(z.string()).max(6).optional() }),
      run: ({ question, options }, signal) => executive.ask(question, options, signal),
    }),
    tool({
      name: "report",
      description: "Send the supervisor a progress update without stopping, e.g. partway through a long task or when something notable happens.",
      input: z.object({ message: z.string() }),
      run: ({ message }) => {
        executive.tell(message);
        return "Sent.";
      },
    }),
    ...teamTools,
  ];
}
