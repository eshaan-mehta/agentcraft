// The bot's capabilities as one table of methods. Agent-written scripts call these
// through the sandbox (as `api.name(...)`), and Claude's tools are thin wrappers over
// the same methods, so there is exactly one implementation of every action.
import type { Bot } from "mineflayer";
import type { Motor, Slot } from "./body/motor.js";
import { pause } from "./body/motor.js";
import type { Target } from "./body/navigation.js";
import { say } from "./comms.js";
import { ActionError } from "./errors.js";
import * as skills from "./skills/builtin.js";
import type { Knowledge } from "./world/knowledge.js";
import type { Memory } from "./world/memory.js";
import * as see from "./world/perception.js";

export interface ApiDeps {
  bot: Bot;
  motor: Motor;
  knowledge: Knowledge;
  memory: Memory;
}

export interface Method {
  /** Needs control of the bot's body (moves, digs, places, uses items). */
  body: boolean;
  signature: string;
  doc: string;
  run(args: unknown[], signal: AbortSignal): unknown;
}

// ---- Argument checking: scripts pass JSON, so validate shapes with clear errors ----

function str(value: unknown, what: string): string {
  if (typeof value !== "string" || !value) throw new ActionError("INVALID", `${what} must be a non-empty string.`);
  return value;
}

function num(value: unknown, what: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ActionError("INVALID", `${what} must be a number.`);
  return value;
}

function obj<T extends object>(value: unknown): T {
  return (value && typeof value === "object" ? value : {}) as T;
}

function pos(value: unknown, what = "position"): see.Pos {
  const v = value as Partial<see.Pos> | null;
  if (!v || typeof v !== "object" || [v.x, v.y, v.z].some((n) => typeof n !== "number")) {
    throw new ActionError("INVALID", `${what} must be {x, y, z} numbers.`);
  }
  return { x: v.x!, y: v.y!, z: v.z! };
}

export function createApi({ bot, motor, knowledge, memory }: ApiDeps): Record<string, Method> {
  const ctx = { bot, motor, knowledge, memory };

  const entity = (id: unknown) => motor.entity(num(id, "entity id"));

  /** Turns a script-side target (plain JSON, entities by id) into a navigation target. */
  const target = (value: unknown): Target => {
    const t = obj<Record<string, unknown>>(value);
    if ("waypoint" in t) {
      const w = memory.waypoint(str(t.waypoint, "waypoint"));
      if (!w) throw new ActionError("NOT_FOUND", `No waypoint named "${t.waypoint}".`);
      return { x: w.x, y: w.y, z: w.z, range: typeof t.range === "number" ? t.range : 1 };
    }
    if ("reach" in t) return { reach: pos(t.reach, "reach") };
    if ("entity" in t) return { entity: entity(t.entity), range: typeof t.range === "number" ? t.range : 2 };
    if ("awayFrom" in t) {
      const from = typeof t.awayFrom === "number" ? entity(t.awayFrom) : pos(t.awayFrom, "awayFrom");
      return { awayFrom: from, distance: num(t.distance, "distance") };
    }
    if (typeof t.x === "number" && typeof t.z === "number") {
      return typeof t.y === "number"
        ? { x: t.x, y: t.y, z: t.z, range: typeof t.range === "number" ? t.range : 1 }
        : { x: t.x, z: t.z, range: typeof t.range === "number" ? t.range : 1 };
    }
    throw new ActionError("INVALID", "Target must be {x,y,z}, {x,z}, {reach:{x,y,z}}, {entity:id}, {awayFrom:..., distance}, or {waypoint:name}.");
  };

  const m = (body: boolean, signature: string, doc: string, run: Method["run"]): Method => ({ body, signature, doc, run });

  return {
    // ---- Perception ----
    status: m(false, "status()", "Position, health, food, time {timeOfDay, day, phase}, equipment, inventory counts, hostilesNearby, sheltered.", () => see.status(bot)),
    inventory: m(false, "inventory()", "Item counts by name, e.g. {oak_log: 12}.", () => Object.fromEntries(see.inventoryCounts(bot))),
    blockAt: m(false, "blockAt(pos)", "Block at {x,y,z}: {name, properties (state like age/facing/open), solid, diggable, harvestWith, light}.", ([p]) =>
      see.blockInfo(bot, pos(p)),
    ),
    findBlocks: m(
      false,
      "findBlocks(query, {maxDistance?, count?, near?, exposedOnly?})",
      "Nearest blocks matching a name ('oak_log', or partial 'log'; exact ores include deepslate variants): [{name, x, y, z, distance}].",
      async ([q, o]) => {
        await see.terrainLoaded(bot);
        return see.findBlocks(bot, str(q, "query"), obj(o));
      },
    ),
    findEntities: m(
      false,
      "findEntities({kind?, name?, maxDistance?, count?})",
      "Nearby entities, nearest first. kind: hostile | animal | passive | item | player | other. Returns [{id, name, kind, x, y, z, distance, item?, count?}] (item/count for dropped items).",
      ([o]) => see.findEntities(bot, obj(o)),
    ),
    scanSurface: m(false, "scanSurface({center?, radius?})", "Text map of surface blocks and heights around a point (radius up to 16).", ([o]) => {
      const opts = obj<{ center?: see.Pos; radius?: number }>(o);
      return see.scanSurface(bot, opts.center ? pos(opts.center) : bot.entity.position, opts.radius ?? 8);
    }),
    scanLayer: m(false, "scanLayer(y, {center?, radius?})", "Text map of the blocks in one horizontal slice at height y.", ([y, o]) => {
      const opts = obj<{ center?: see.Pos; radius?: number }>(o);
      return see.scanLayer(bot, opts.center ? pos(opts.center) : bot.entity.position, opts.radius ?? 8, num(y, "y"));
    }),
    canReach: m(false, "canReach(target)", "Plans a route without moving: {reachable, status, steps}. Same targets as goTo.", ([t]) => motor.nav.check(target(t))),

    // ---- Knowledge ----
    recipes: m(false, "recipes(item)", "Crafting recipes: [{result, ingredients: {name: count}, table}].", ([i]) => knowledge.recipes(str(i, "item"))),
    howToObtain: m(false, "howToObtain(item)", "Every way to get an item (craft, smelt, mine with which tool, mob drops), as text.", ([i]) =>
      knowledge.howToObtain(str(i, "item")),
    ),
    materials: m(false, "materials(item, count)", "Bill of materials from the current inventory: {steps, raw: [{item, count, how}], used}.", ([i, c]) =>
      knowledge.materials(str(i, "item"), num(c, "count", 1)),
    ),
    info: m(false, "info(name)", "Facts about a block, item, or mob: hardness, tool, drops, food value, stack size.", ([n]) => knowledge.info(str(n, "name"))),

    // ---- Movement ----
    goToSurface: m(true, "goToSurface()", "Climb out from underground to the open ground above, digging a staircase if needed.", (_args, signal) => motor.goToSurface(signal)),
    goTo: m(
      true,
      "goTo(target, {careful?, timeoutMs?})",
      "Walk there, digging/bridging as needed (careful: never break or place blocks). target: {x,y,z,range?} | {x,z,range?} | {reach:{x,y,z}} (stand within arm's reach of a block) | {entity:id,range?} | {awayFrom:{x,y,z}|id, distance} | {waypoint:name}. Throws UNREACHABLE/STUCK/TIMEOUT.",
      ([t, o], signal) => motor.goTo(target(t), { ...obj<{ careful?: boolean; timeoutMs?: number }>(o), signal }),
    ),
    lookAt: m(true, "lookAt(pos)", "Turn to face a point.", async ([p]) => {
      await motor.lookAt(pos(p));
      return "ok";
    }),
    controls: m(
      true,
      "controls({forward?, back?, left?, right?, jump?, sprint?, sneak?}, ms)",
      "Hold movement keys for up to 10s, then release. For fine moves the pathfinder can't do.",
      ([states, ms], signal) => motor.controls(obj(states), num(ms, "ms"), signal),
    ),

    // ---- Blocks ----
    dig: m(true, "dig(pos, {requireDrop?})", "Mine a block (walks within reach) and pick up the drop: {mined, change, warning?}. requireDrop: fail instead of mining with the wrong tool.", ([p, o], signal) =>
      motor.dig(pos(p), signal, { requireDrop: obj<{ requireDrop?: boolean }>(o).requireDrop }),
    ),
    place: m(true, "place(item, pos)", "Place a block from the inventory at a position (needs a solid neighbor; clears grass/flowers).", ([i, p], signal) =>
      motor.place(str(i, "item"), pos(p), signal),
    ),
    useBlock: m(
      true,
      "useBlock(pos, item?)",
      "Right-click a block, optionally holding an item: doors, levers, buttons, hoe on dirt, seeds on farmland, bone meal, buckets. Reports the block's state after.",
      ([p, i], signal) => motor.useBlock(pos(p), i === undefined ? undefined : str(i, "item"), signal),
    ),

    // ---- Items ----
    equip: m(true, "equip(item, slot?)", "Hold or wear an item. slot: hand | off-hand | head | torso | legs | feet.", ([i, s]) =>
      motor.equip(str(i, "item"), (s as Slot | undefined) ?? "hand"),
    ),
    unequip: m(true, "unequip(slot)", "Empty a slot.", ([s]) => motor.unequip(str(s, "slot") as Slot)),
    useItem: m(true, "useItem(item?, holdMs?)", "Right-click the air: throw, drink, raise a shield, draw and release a bow (holdMs ~1000).", ([i, h], signal) =>
      motor.useItem(i === undefined ? undefined : str(i, "item"), num(h, "holdMs", 100), signal),
    ),
    toss: m(true, "toss(item, count?)", "Drop items on the ground.", ([i, c]) => motor.toss(str(i, "item"), c === undefined ? undefined : num(c, "count"))),
    eat: m(true, "eat(item?)", "Eat (the most filling safe food if no item given). Fails when full.", ([i]) => motor.eat(i === undefined ? undefined : str(i, "item"))),

    // ---- Entities ----
    attack: m(true, "attack(id)", "Hit an entity once (must be within ~3.5 blocks).", async ([id]) => {
      const e = entity(id);
      await bot.lookAt(e.position.offset(0, e.height * 0.85, 0), true);
      bot.attack(e);
      return `Hit ${e.name}.`;
    }),
    fight: m(true, "fight(id, {timeoutMs?})", "Chase and fight an entity until it dies: 'killed' | 'unreachable' | 'lost' | 'timeout'.", ([id, o], signal) =>
      motor.fight(entity(id), { signal, timeoutMs: obj<{ timeoutMs?: number }>(o).timeoutMs ?? 45_000 }),
    ),
    interact: m(true, "interact(id, item?)", "Right-click an entity, optionally holding an item: shear, milk, breed, feed, trade.", ([id, i], signal) =>
      motor.interact(num(id, "id"), i === undefined ? undefined : str(i, "item"), signal),
    ),
    mount: m(true, "mount(id)", "Ride a boat, minecart, or horse.", ([id], signal) => motor.mount(num(id, "id"), signal)),
    dismount: m(true, "dismount()", "Get off.", () => motor.dismount()),
    collectDrops: m(true, "collectDrops(radius?)", "Walk over and pick up dropped items nearby.", async ([r], signal) => {
      await motor.collectDrops(bot.entity.position, num(r, "radius", 8), signal);
      return Object.fromEntries(see.inventoryCounts(bot));
    }),

    // ---- Crafting ----
    craft: m(
      true,
      "craft(item, count)",
      "Craft an item and everything it needs in between (planks, sticks...), setting up a crafting table or furnace if needed. Throws MISSING_ITEMS listing raw materials to gather.",
      ([i, c], signal) => skills.craftItem(ctx, str(i, "item"), num(c, "count", 1), signal),
    ),
    smelt: m(true, "smelt(input, count)", "Smelt items (places a furnace if needed, adds fuel). One item is waited for; a bigger batch is left cooking (~10s an item) and this returns at once: collect it later with collectSmelted.", ([i, c], signal) =>
      skills.smeltItem(ctx, str(i, "input"), num(c, "count", 1), signal),
    ),
    collectSmelted: m(true, "collectSmelted(pos?)", "Take finished items out of a furnace (nearest, or at pos); says what's still cooking.", ([p], signal) =>
      motor.collectSmelted(p ? pos(p) : null, signal),
    ),
    fish: m(true, "fish(count)", "Fish with a fishing rod at open water within 16 blocks until count catches.", ([c], signal) => motor.fish(num(c, "count", 5), signal)),
    container: m(
      true,
      "container(action, {pos?, item?, count?})",
      "action: list | deposit | withdraw, on the nearest chest/barrel unless pos is given. Deposit with no item stores everything but tools, armor, and food.",
      ([a, o], signal) => {
        const opts = obj<{ pos?: see.Pos; item?: string; count?: number }>(o);
        const action = str(a, "action");
        if (!["list", "deposit", "withdraw"].includes(action)) throw new ActionError("INVALID", "action must be list, deposit, or withdraw.");
        return motor.container(opts.pos ? pos(opts.pos) : undefined, action as "list", opts.item, opts.count, signal);
      },
    ),

    // ---- Skills ----
    gather: m(
      true,
      "gather(query, count, {near?, radius?})",
      "Mine `count` blocks matching a name around a point (default: you), lowest/nearest first, skipping ones that fail. Item names work too ('cobblestone' mines stone, 'raw_iron' mines iron ore). Returns {mined, wanted, change, stoppedBecause?, failures?}.",
      ([q, c, o], signal) => skills.gather(ctx, str(q, "query"), num(c, "count"), { ...obj<{ near?: see.Pos; radius?: number }>(o), signal }),
    ),
    hunt: m(true, "hunt(name, count)", "Kill animals or mobs of a type nearby and collect the drops.", ([n, c], signal) =>
      skills.hunt(ctx, str(n, "name"), num(c, "count", 1), signal),
    ),
    explore: m(true, "explore(direction, distance)", "Travel north/south/east/west/northeast/... to find new terrain; reports what's there.", ([d, n], signal) =>
      skills.explore(ctx, str(d, "direction"), num(n, "distance", 64), signal),
    ),
    buildShelter: m(true, "buildShelter()", "Seal yourself in where you stand (dig in, or wall in with a roof).", (_args, signal) => skills.buildShelter(ctx, signal)),
    sleep: m(true, "sleep()", "Sleep in the nearest bed (at night).", (_args, signal) => motor.sleep(signal)),
    wake: m(true, "wake()", "Get out of bed.", () => motor.wake()),

    // ---- Time, memory, chat ----
    wait: m(false, "wait(ms)", "Pause briefly, up to 2 seconds (e.g. for drops to land). Never wait for things like furnaces or daylight: do something else meanwhile.", async ([ms], signal) => {
      await pause(Math.min(num(ms, "ms"), 2_000), signal);
      return "ok";
    }),
    say: m(false, "say(text)", "Send a message to the supervisor in chat.", ([t]) => {
      say(bot, str(t, "text"));
      return "sent";
    }),
    getWaypoint: m(false, "getWaypoint(name)", "A remembered place: {x, y, z, note} or null.", ([n]) => memory.waypoint(str(n, "name"))),
    setWaypoint: m(false, "setWaypoint(name, pos?, note?)", "Remember a place (default: where you stand).", ([n, p, note]) => {
      memory.setWaypoint(str(n, "name"), p === undefined ? bot.entity.position : pos(p), note === undefined ? undefined : String(note));
      return "saved";
    }),
  };
}

/** The API reference for the run_code tool description. */
export function apiReference(api: Record<string, Method>): string {
  return Object.values(api)
    .map((method) => `api.${method.signature} - ${method.doc}`)
    .join("\n");
}

