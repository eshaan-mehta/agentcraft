// Built-in skills: multi-step behaviors that come up constantly, written on the
// motor primitives with progress checks and fallbacks. Agent-written skills sit
// alongside these.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Motor } from "../body/motor.js";
import { pause } from "../body/motor.js";
import { ActionError, Interrupted, errorText } from "../errors.js";
import type { Knowledge } from "../world/knowledge.js";
import { formatMaterials } from "../world/knowledge.js";
import type { Memory } from "../world/memory.js";
import {
  describeSurroundings,
  distanceTo,
  enclosure,
  exposed,
  findEntities,
  formatPos,
  inventoryCounts,
  inventoryDiff,
  isHostile,
  isSheltered,
  itemByName,
  normalizeName,
  resolveBlocks,
  shelterBlocks,
  terrainLoaded,
  toVec,
  type Pos,
} from "../world/perception.js";

export interface SkillContext {
  bot: Bot;
  motor: Motor;
  knowledge: Knowledge;
  memory: Memory;
}

type Signal = AbortSignal | undefined;

// ---- Gathering -----------------------------------------------------------------

/**
 * Mines `count` blocks matching a query, nearest-first around `near` (default: the
 * bot), preferring low, exposed blocks so trees get cut from the trunk up. Targets
 * that fail are skipped; it stops after four failures in a row or when none are left.
 */
export async function gather(
  ctx: SkillContext,
  query: string,
  count: number,
  options: { near?: Pos; radius?: number; signal?: Signal } = {},
) {
  const { bot, motor } = ctx;
  const ids = gatherTargets(ctx, query);
  await terrainLoaded(bot);
  const radius = Math.min(options.radius ?? 48, 128);
  const before = inventoryCounts(bot);
  const failed = new Map<string, string>();
  const deadline = Date.now() + Math.min(120_000 + count * 30_000, 1_200_000);
  let mined = 0;
  let streak = 0;
  let stopped = "";

  while (mined < count) {
    if (options.signal?.aborted) throw new Interrupted();
    if (Date.now() > deadline) {
      stopped = "ran out of time";
      break;
    }
    const center = options.near ? toVec(options.near) : bot.entity.position;
    const feetY = bot.entity.position.y;
    const target = bot
      .findBlocks({ matching: ids, maxDistance: radius, count: 256, point: center })
      .filter((p) => !failed.has(p.toString()) && liquidBeside(bot, p) !== "lava" && !unripe(bot, p))
      // Nearest first; prefer blocks with an open face, and ones you can reach without
      // climbing. Buried blocks (stone under dirt) are fine: the path digs down to them.
      // Avoid underwater ones (drowning) unless there's nothing else.
      .map((p) => ({
        p,
        score:
          distanceTo(bot, p) +
          3 * Math.max(0, p.y - feetY - 2) +
          2 * Math.max(0, feetY - p.y - 3) +
          (exposed(bot, p) ? 0 : 6) +
          (liquidBeside(bot, p) === "water" ? 24 : 0),
      }))
      .sort((a, b) => a.score - b.score)[0]?.p;
    if (!target) {
      const growing = bot.findBlocks({ matching: ids, maxDistance: radius, count: 64, point: center }).filter((p) => unripe(bot, p)).length;
      stopped = `no more ${growing ? "ripe " : ""}${query} within ${radius} blocks of ${formatPos(center)}${growing ? ` (${growing} still growing)` : ""}`;
      break;
    }
    const block = bot.blockAt(target)!;
    const problem = motor.harvestProblem(block);
    if (problem) throw new ActionError("MISSING_TOOL", `${problem}. Mined ${mined}/${count} before stopping.`);
    try {
      await motor.dig(target, options.signal, { collect: true });
      mined++;
      streak = 0;
    } catch (err) {
      if (err instanceof Interrupted) throw err;
      failed.set(target.toString(), `${block.name} at ${formatPos(target)}: ${errorText(err)}`);
      if (++streak >= 4) {
        stopped = "four targets in a row failed";
        break;
      }
    }
  }

  const result = {
    mined,
    wanted: count,
    change: inventoryDiff(before, inventoryCounts(bot)),
    ...(stopped ? { stoppedBecause: stopped } : {}),
    ...(failed.size ? { failures: [...failed.values()].slice(-5) } : {}),
  };
  if (mined === 0) {
    const hint = stopped.startsWith("no more") ? " Try explore to load new terrain, or a larger radius." : "";
    throw new ActionError(stopped.startsWith("no more") ? "NOT_FOUND" : "FAILED", `Mined nothing: ${stopped || "every attempt failed"}.${hint}`, result);
  }
  return result;
}

// Crops are only worth harvesting fully grown: an unripe one gives back just its seed.
const RIPE_AGE: Record<string, number> = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3, nether_wart: 3, cocoa: 2 };

function unripe(bot: Bot, p: Vec3): boolean {
  const block = bot.blockAt(p);
  const ripe = block ? RIPE_AGE[block.name] : undefined;
  return ripe !== undefined && Number(block!.getProperties().age ?? ripe) < ripe;
}

/** Lava or water touching a block: mining it would let the liquid in on you. */
function liquidBeside(bot: Bot, p: Vec3): "lava" | "water" | null {
  let found: "lava" | "water" | null = null;
  for (const offset of [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
    const name = bot.blockAt(p.plus(offset))?.name;
    if (name === "lava") return "lava";
    if (name === "water") found = "water";
  }
  return found;
}

/**
 * Block ids to mine for a query: the blocks it names, plus blocks that drop it as an
 * item ("cobblestone" -> stone too; "raw_iron" -> iron ores; "coal" -> coal ores).
 */
function gatherTargets(ctx: SkillContext, query: string): number[] {
  const byName = ctx.bot.registry.blocksByName;
  const names = new Set<string>();
  try {
    for (const name of resolveBlocks(ctx.bot, query).names) names.add(name);
  } catch {
    // Not a block name; it may still be an item some block drops.
  }
  for (const source of ctx.knowledge.blockSources(normalizeName(query))) {
    if (source.chance >= 0.1) names.add(source.block);
  }
  if (!names.size) throw new ActionError("INVALID", `"${query}" isn't a block, and no block drops it. Use lookup to see how to get it.`);
  return [...names].map((n) => byName[n]?.id).filter((id): id is number => id !== undefined);
}

// ---- Crafting stations ---------------------------------------------------------------

/** Makes sure a crafting table is within 32 blocks: uses one nearby, places one carried, or crafts one. */
export async function ensureCraftingTable(ctx: SkillContext, signal: Signal): Promise<string> {
  const near = ctx.motor.nearestBlock(["crafting_table"]);
  if (near) return `crafting table at ${formatPos(near.position)}`;
  if (!inventoryCounts(ctx.bot).get("crafting_table")) await craftItem(ctx, "crafting_table", 1, signal);
  return placeStation(ctx, "crafting_table", signal);
}

/** Makes sure a furnace is within 32 blocks: uses one nearby, places one carried, or crafts one. */
export async function ensureFurnace(ctx: SkillContext, signal: Signal): Promise<string> {
  const near = ctx.motor.nearestBlock(["furnace"]);
  if (near) return `furnace at ${formatPos(near.position)}`;
  if (!inventoryCounts(ctx.bot).get("furnace")) await craftItem(ctx, "furnace", 1, signal);
  return placeStation(ctx, "furnace", signal);
}

async function placeStation(ctx: SkillContext, item: string, signal: Signal): Promise<string> {
  const spot = ctx.motor.findPlacementSpot();
  if (!spot) throw new ActionError("BLOCKED", `No free spot nearby to put down a ${item}. Move to open, flat ground.`);
  await ctx.motor.place(item, spot, signal);
  return `placed a ${item} at ${formatPos(spot)}`;
}

// ---- Crafting ------------------------------------------------------------------

/**
 * Crafts an item along with everything it needs in between (planks, sticks, ...),
 * smelting where required and setting up a crafting table or furnace if there isn't
 * one. If raw materials are missing, says exactly what to gather.
 */
export async function craftItem(ctx: SkillContext, item: string, count: number, signal: Signal) {
  const { bot, knowledge, motor } = ctx;
  const name = itemByName(bot, item).name;
  const before = inventoryCounts(bot);
  let plan = knowledge.materials(name, count);
  if (plan.raw.length) throw new ActionError("MISSING_ITEMS", formatMaterials(name, count, plan));

  // A table or furnace costs materials too, so set those up first and re-plan.
  const notes: string[] = [];
  if (plan.steps.some((s) => s.action === "craft" && s.table) && name !== "crafting_table") notes.push(await ensureCraftingTable(ctx, signal));
  if (plan.steps.some((s) => s.action === "smelt") && name !== "furnace") notes.push(await ensureFurnace(ctx, signal));
  if (notes.length) {
    plan = knowledge.materials(name, count);
    if (plan.raw.length) throw new ActionError("MISSING_ITEMS", `After setting up (${notes.join("; ")}):\n${formatMaterials(name, count, plan)}`);
  }

  for (const step of plan.steps) {
    if (signal?.aborted) throw new Interrupted();
    if (step.action === "craft") await motor.craft(step.item, step.count, signal);
    else await motor.smelt(step.from!, step.count, signal, { wait: true }); // the next step needs it
  }
  const have = inventoryCounts(bot).get(name) ?? 0;
  return {
    item: name,
    have,
    steps: plan.steps.map((s) => (s.action === "craft" ? `crafted ${s.count} ${s.item}` : `smelted ${s.count} ${s.from} -> ${s.item}`)),
    ...(notes.length ? { setup: notes } : {}),
    change: inventoryDiff(before, inventoryCounts(bot)),
  };
}

export async function smeltItem(ctx: SkillContext, input: string, count: number, signal: Signal) {
  const setup = await ensureFurnace(ctx, signal);
  const result = await ctx.motor.smelt(input, count, signal);
  return { ...result, furnace: setup };
}

// ---- Shelter --------------------------------------------------------------------

const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
const NEIGHBORS = [new Vec3(0, -1, 0), ...SIDES, new Vec3(0, 1, 0)];

/** Shuffles to the middle of a block, so the bot fits a 1x1 hole or enclosure. */
async function centerOn(bot: Bot, cell: Vec3, signal: Signal): Promise<boolean> {
  const center = cell.offset(0.5, 0, 0.5);
  bot.setControlState("sneak", true); // sneaking never walks off an edge
  try {
    for (let i = 0; i < 40; i++) {
      const pos = bot.entity.position;
      if (Math.abs(pos.x - center.x) < 0.12 && Math.abs(pos.z - center.z) < 0.12) return true;
      await bot.lookAt(new Vec3(center.x, pos.y + bot.entity.height, center.z), true);
      bot.setControlState("forward", true);
      await pause(50, signal);
      bot.setControlState("forward", false);
      await pause(100, signal);
    }
    return false;
  } finally {
    bot.setControlState("forward", false);
    bot.setControlState("sneak", false);
  }
}

/** Why digging straight down 3 blocks here would be unsafe, or null if it's fine. */
function digInProblem(bot: Bot, feet: Vec3): string | null {
  const items = bot.inventory.items();
  for (let depth = 1; depth <= 3; depth++) {
    const block = bot.blockAt(feet.offset(0, -depth, 0));
    if (!block || block.boundingBox !== "block" || !block.diggable) return `${block?.name ?? "an unloaded block"} is in the way`;
    // Stone and the like take many seconds each by hand: too slow when it matters.
    const tools = block.harvestTools;
    if (tools && !items.some((i) => tools[i.type])) return `the ground (${block.name}) is too hard to dig without the right tool`;
  }
  if (bot.blockAt(feet.offset(0, -4, 0))?.boundingBox !== "block") return "there's a gap or cave underneath";
  for (let depth = 1; depth <= 4; depth++) {
    for (const side of SIDES) {
      const block = bot.blockAt(feet.offset(side.x, -depth, side.z));
      if (!block) return "the area isn't loaded";
      if (/water|lava/.test(block.name)) return `there's ${block.name} next to where the hole would be`;
      if ((depth === 2 || depth === 3) && block.boundingBox !== "block") return "the hole would have an opening in its side";
    }
  }
  return null;
}

/** Blocks to place, in order, to wall the bot in: four sides two high, a support, then a roof. */
function planWalls(bot: Bot, feet: Vec3): Vec3[] | string {
  const plan: Vec3[] = [];
  const solid = (cell: Vec3) => bot.blockAt(cell)?.boundingBox === "block" || plan.some((p) => p.equals(cell));
  const supported = (cell: Vec3) => NEIGHBORS.some((offset) => solid(cell.plus(offset)));
  const targets = [...SIDES.map((s) => feet.plus(s)), ...SIDES.map((s) => feet.plus(s).offset(0, 1, 0)), feet.offset(1, 2, 0), feet.offset(0, 2, 0)];
  for (const cell of targets) {
    if (solid(cell)) continue;
    if (!supported(cell)) {
      const below = cell.offset(0, -1, 0);
      if (!supported(below)) return `there's nothing to build on around ${formatPos(cell)}`;
      plan.push(below);
    }
    plan.push(cell);
  }
  return plan;
}

async function waitToLand(bot: Bot, y: number, signal: Signal) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (bot.entity.onGround && Math.floor(bot.entity.position.y) <= y) return;
    await pause(50, signal);
  }
  throw new ActionError("FAILED", "Didn't drop into the hole as expected. Move a little and try again.");
}

/**
 * Seals the bot into an emergency shelter where it stands: digs 3 down and covers the
 * hole (1 block), or walls it in with a roof where digging isn't safe (up to 11).
 */
export async function buildShelter(ctx: SkillContext, signal: Signal): Promise<string> {
  const { bot, motor } = ctx;
  // Enclosed already, unless a mob is shut in too (then dig in, away from it).
  const space = enclosure(bot);
  if (space && !Object.values(bot.entities).some((e) => isHostile(e) && space.has(e.position.floored().toString()))) {
    return "Already in an enclosed space.";
  }
  bot.pathfinder.setGoal(null);
  const feet = bot.entity.position.floored();
  if (bot.blockAt(feet.offset(0, -1, 0))?.boundingBox !== "block") throw new ActionError("BLOCKED", "Need to be standing on solid ground.");
  const digProblem = digInProblem(bot, feet);
  const available = shelterBlocks(bot).reduce((sum, i) => sum + i.count, 0);
  // Digging in needs one block for the hatch, and digging usually picks up a few.
  if (!available && digProblem) {
    throw new ActionError("MISSING_ITEMS", `No building blocks (dirt, cobblestone, stone, planks), and can't dig in here (${digProblem}). Collect some first; dirt is quickest.`);
  }
  if (!(await centerOn(bot, feet, signal))) throw new ActionError("FAILED", "Couldn't line up in the middle of the block. Try again from flatter ground.");

  if (!digProblem) {
    for (let depth = 1; depth <= 3; depth++) {
      await motor.dig(feet.offset(0, -depth, 0), signal, { collect: false });
      await waitToLand(bot, feet.y - depth, signal);
    }
    for (let i = 0; i < 10 && !shelterBlocks(bot).length; i++) await pause(100, signal); // the dug blocks get picked up
    const seal = shelterBlocks(bot)[0];
    if (!seal) throw new ActionError("MISSING_ITEMS", `Dug in 3 deep at ${formatPos(feet)} but have no block to seal the top.`);
    const hatch = feet.offset(0, -1, 0);
    const placed = await motor.placeInReach(seal.type, hatch, signal);
    return `Dug in and sealed the hole above with ${placed} at ${formatPos(hatch)}. Now at ${formatPos(bot.entity.position)}, safe from mobs.${
      isSheltered(bot) ? "" : " (Warning: the space doesn't look fully enclosed.)"
    } To leave, go_to somewhere or dig the block above.`;
  }

  const plan = planWalls(bot, feet);
  if (typeof plan === "string") throw new ActionError("BLOCKED", `Can't dig in here (${digProblem}), and can't wall in either: ${plan}.`);
  if (plan.length > available) {
    throw new ActionError("MISSING_ITEMS", `Can't dig in here (${digProblem}), and walling in needs ${plan.length} blocks but you have ${available}.`);
  }
  for (const cell of plan) {
    const stack = shelterBlocks(bot)[0];
    if (!stack) throw new ActionError("MISSING_ITEMS", "Ran out of building blocks partway through.");
    await motor.placeInReach(stack.type, cell, signal);
  }
  return `Walled in at ${formatPos(feet)} with a roof, using ${plan.length} blocks; safe from mobs.${
    isSheltered(bot) ? "" : " (Warning: the space doesn't look fully enclosed.)"
  } To leave, go_to somewhere or dig a wall block.`;
}

// ---- Exploring and hunting ----------------------------------------------------------

const DIRECTIONS: Record<string, [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
  northeast: [0.7, -0.7],
  northwest: [-0.7, -0.7],
  southeast: [0.7, 0.7],
  southwest: [-0.7, 0.7],
};

/**
 * Travels `distance` blocks in a direction to find new terrain, veering 45 degrees
 * either way if the straight route is blocked. Reports what's around on arrival.
 */
export async function explore(ctx: SkillContext, direction: string, distance: number, signal: Signal) {
  const { bot, motor } = ctx;
  const start = bot.entity.position.clone();
  const base = DIRECTIONS[normalizeName(direction)];
  if (!base) throw new ActionError("INVALID", `Direction must be one of ${Object.keys(DIRECTIONS).join(", ")}.`);
  const angle = Math.atan2(base[1], base[0]);
  const attempts: string[] = [];
  for (const offset of [0, Math.PI / 4, -Math.PI / 4]) {
    const x = start.x + Math.cos(angle + offset) * distance;
    const z = start.z + Math.sin(angle + offset) * distance;
    try {
      await motor.goTo({ x, z, range: 4 }, { signal });
      break;
    } catch (err) {
      if (err instanceof Interrupted) throw err;
      attempts.push(errorText(err));
    }
  }
  const moved = Math.round(bot.entity.position.distanceTo(start));
  if (moved < 8) throw new ActionError("STUCK", `Couldn't get anywhere ${direction}: ${attempts.join(" / ")}`);
  return `Traveled ${moved} blocks ${direction}${attempts.length ? ` (after detours: ${attempts.length})` : ""}.\n${describeSurroundings(bot, 32)}`;
}

/** Hunts `count` animals (or mobs) of a type nearby and picks up the drops. */
export async function hunt(ctx: SkillContext, name: string, count: number, signal: Signal) {
  const { bot, motor } = ctx;
  const before = inventoryCounts(bot);
  let killed = 0;
  const notes: string[] = [];
  while (killed < count) {
    if (signal?.aborted) throw new Interrupted();
    const target = findEntities(bot, { name, maxDistance: 48 }).find((e) => e.kind !== "item" && e.kind !== "player");
    if (!target) {
      notes.push(`no more ${name} within 48 blocks`);
      break;
    }
    const entity = bot.entities[target.id];
    if (!entity) continue;
    const result = await motor.fight(entity, { signal, timeoutMs: 45_000 });
    if (result === "killed") {
      killed++;
      await motor.collectDrops(entity.position, 6, signal);
    } else {
      notes.push(`a ${name} at ${formatPos(entity.position)}: ${result}`);
      if (notes.length >= 3) break;
    }
  }
  const result = { killed, wanted: count, change: inventoryDiff(before, inventoryCounts(bot)), ...(notes.length ? { notes } : {}) };
  if (!killed) throw new ActionError("NOT_FOUND", `Killed no ${name}: ${notes.join("; ")}.`, result);
  return result;
}
