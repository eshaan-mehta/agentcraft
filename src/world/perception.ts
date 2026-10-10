// Read-only queries about the bot and the world. Everything returns plain data or
// text, so it can go straight to the model or across the sandbox boundary.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { ActionError } from "../errors.js";

type Entity = Bot["entity"];
type Block = NonNullable<ReturnType<Bot["blockAt"]>>;
export interface Pos {
  x: number;
  y: number;
  z: number;
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/^minecraft:/, "").replace(/\s+/g, "_");
}

export function formatPos(pos: Pos): string {
  return `${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}`;
}

/** Whole-block coordinates as plain data. */
export function point(pos: Pos): Pos {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
}

export function toVec(pos: Pos): Vec3 {
  return new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
}

/**
 * Waits (up to a limit) for the chunks around the bot to arrive. Right after joining,
 * respawning, or a long trip, block searches otherwise come back empty.
 */
export async function terrainLoaded(bot: Bot, timeoutMs = 10_000) {
  await Promise.race([bot.waitForChunksToLoad(), new Promise((r) => setTimeout(r, timeoutMs))]);
}

export function distanceTo(bot: Bot, pos: Pos): number {
  return bot.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z));
}

function suggestions(names: string[], query: string): string {
  const close = names.filter((n) => n.includes(query) || query.includes(n)).slice(0, 8);
  return close.length ? ` Similar names: ${close.join(", ")}.` : "";
}

export function itemByName(bot: Bot, name: string) {
  const key = normalizeName(name);
  const item = bot.registry.itemsByName[key];
  if (!item) throw new ActionError("INVALID", `Unknown item "${name}".${suggestions(Object.keys(bot.registry.itemsByName), key)}`);
  return item;
}

/**
 * Resolves a block query to registry ids. An exact ID matches itself plus its
 * deepslate variant ("iron_ore" -> iron_ore, deepslate_iron_ore); anything else
 * matches every block whose ID contains the query ("log" -> all logs).
 */
export function resolveBlocks(bot: Bot, query: string): { ids: number[]; names: string[] } {
  const key = normalizeName(query);
  const byName = bot.registry.blocksByName;
  const names = byName[key]
    ? [key, `deepslate_${key}`].filter((n) => byName[n])
    : Object.keys(byName).filter((n) => n.includes(key));
  if (!names.length) throw new ActionError("INVALID", `Unknown block "${query}".${suggestions(Object.keys(byName), key)}`);
  return { ids: names.map((n) => byName[n]!.id), names };
}

// ---- Inventory ------------------------------------------------------------

export function inventoryCounts(bot: Bot): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of bot.inventory.items()) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return counts;
}

export function countItem(bot: Bot, name: string): number {
  return inventoryCounts(bot).get(normalizeName(name)) ?? 0;
}

export function countById(bot: Bot, id: number): number {
  return bot.inventory.items().reduce((sum, i) => (i.type === id ? sum + i.count : sum), 0);
}

export function inventorySummary(bot: Bot): string {
  const entries = [...inventoryCounts(bot)].sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([name, n]) => `${name} x${n}`).join(", ") : "empty";
}

export function inventoryDiff(before: Map<string, number>, after: Map<string, number>): string {
  const changes: string[] = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(name) ?? 0) - (before.get(name) ?? 0);
    if (delta !== 0) changes.push(`${delta > 0 ? "+" : ""}${delta} ${name}`);
  }
  return changes.length ? changes.join(", ") : "no change";
}

const ARMOR_SLOTS = { head: 5, torso: 6, legs: 7, feet: 8 } as const;

export function equipment(bot: Bot): Record<string, string | null> {
  return {
    hand: bot.heldItem?.name ?? null,
    offHand: bot.inventory.slots[45]?.name ?? null,
    head: bot.inventory.slots[ARMOR_SLOTS.head]?.name ?? null,
    torso: bot.inventory.slots[ARMOR_SLOTS.torso]?.name ?? null,
    legs: bot.inventory.slots[ARMOR_SLOTS.legs]?.name ?? null,
    feet: bot.inventory.slots[ARMOR_SLOTS.feet]?.name ?? null,
  };
}

// ---- Danger, food, gear -----------------------------------------------------

// Hostile by Minecraft's classification, but they leave you alone unless provoked.
const NEUTRAL_UNLESS_PROVOKED = new Set(["enderman", "zombified_piglin", "piglin"]);
// Hostile, but filed under other categories in minecraft-data.
const ALSO_HOSTILE = new Set(["phantom", "slime", "magma_cube", "hoglin", "ghast", "shulker"]);

export function isHostile(entity: Entity): boolean {
  const name = entity.name ?? "";
  return (entity.type === "hostile" && !NEUTRAL_UNLESS_PROVOKED.has(name)) || ALSO_HOSTILE.has(name);
}

const WEAPONS = [
  "netherite_sword", "diamond_sword", "iron_sword", "stone_sword", "copper_sword", "golden_sword", "wooden_sword",
  "netherite_axe", "diamond_axe", "iron_axe", "stone_axe", "copper_axe", "golden_axe", "wooden_axe",
];

export function bestWeapon(bot: Bot) {
  for (const name of WEAPONS) {
    const item = bot.inventory.items().find((i) => i.name === name);
    if (item) return item;
  }
  return null;
}

const BAD_FOOD = new Set(["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chorus_fruit"]);

/** Edible, safe food in the inventory, most filling first. */
export function foods(bot: Bot) {
  const registry = bot.registry.foodsByName;
  return bot.inventory
    .items()
    .filter((i) => registry[i.name] && !BAD_FOOD.has(i.name))
    .sort((a, b) => registry[b.name]!.foodPoints - registry[a.name]!.foodPoints);
}

// Blocks worth spending on an emergency shelter, best first. No gravity blocks.
const SHELTER_BLOCKS = [
  "dirt", "cobblestone", "cobbled_deepslate", "netherrack", "stone", "deepslate", "andesite", "diorite",
  "granite", "tuff", "blackstone", "coarse_dirt", "sandstone", "oak_planks", "spruce_planks", "birch_planks",
  "jungle_planks", "acacia_planks", "dark_oak_planks", "mangrove_planks", "cherry_planks", "pale_oak_planks",
];

export function shelterBlocks(bot: Bot) {
  return bot.inventory
    .items()
    .filter((i) => SHELTER_BLOCKS.includes(i.name))
    .sort((a, b) => SHELTER_BLOCKS.indexOf(a.name) - SHELTER_BLOCKS.indexOf(b.name));
}

/**
 * Whether the bot is in an enclosed, roofed space mobs can't walk into: a flood fill
 * through open blocks from its feet that never reaches open sky and stays small.
 */
export function isSheltered(bot: Bot, maxCells = 300): boolean {
  const start = bot.entity.position.floored();
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const cell = queue.pop()!;
    const key = cell.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > maxCells) return false;
    let roofed = false;
    for (let dy = 1; dy <= 6 && !roofed; dy++) roofed = bot.blockAt(cell.offset(0, dy, 0))?.boundingBox === "block";
    if (!roofed) return false;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]] as const) {
      const next = cell.offset(dx, dy, dz);
      const block = bot.blockAt(next);
      if (block === null) return false;
      if (block.boundingBox === "empty" && !seen.has(next.toString())) queue.push(next);
    }
  }
  return true;
}

function bedNear(bot: Bot): Block | null {
  const ids = Object.values(bot.registry.blocksByName).filter((b) => b.name.endsWith("_bed")).map((b) => b.id);
  return bot.findBlock({ matching: ids, maxDistance: 32 });
}

/** What the bot has for getting through a night, for survival prompts. */
export function readiness(bot: Bot): string {
  const food = new Map<string, number>();
  for (const item of foods(bot)) food.set(item.name, (food.get(item.name) ?? 0) + item.count);
  const eq = equipment(bot);
  const armor = [eq.head, eq.torso, eq.legs, eq.feet].filter(Boolean);
  const blocks = shelterBlocks(bot).reduce((sum, i) => sum + i.count, 0);
  const bed = bedNear(bot);
  return [
    `Weapon: ${bestWeapon(bot)?.name ?? "none"}.`,
    `Food: ${[...food].map(([n, c]) => `${n} x${c}`).join(", ") || "none"}.`,
    `Armor worn: ${armor.join(", ") || "none"}.`,
    `Shelter blocks: ${blocks}.`,
    isSheltered(bot) ? "You're in an enclosed shelter." : "You're out in the open.",
    bed ? `Nearest bed: ${formatPos(bed.position)}.` : "No bed within 32 blocks.",
  ].join(" ");
}

// ---- Status -------------------------------------------------------------------

export function dayPhase(timeOfDay: number): string {
  return timeOfDay < 11000 ? "day" : timeOfDay < 13000 ? "sunset" : timeOfDay < 23000 ? "night" : "sunrise";
}

function nearbyHostiles(bot: Bot, radius: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of Object.values(bot.entities)) {
    if (e !== bot.entity && isHostile(e) && distanceTo(bot, e.position) <= radius) counts.set(e.name!, (counts.get(e.name!) ?? 0) + 1);
  }
  return counts;
}

/** One-line snapshot prepended to every new message the agent receives. */
export function statusLine(bot: Bot): string {
  const t = bot.time.timeOfDay;
  const hostiles = [...nearbyHostiles(bot, 16)].map(([name, n]) => `${name} x${n}`).join(", ");
  return [
    `pos ${formatPos(bot.entity.position)}`,
    `health ${Math.round(bot.health)}/20`,
    `food ${bot.food}/20`,
    `time ${dayPhase(t)} (${t}/24000)${bot.isRaining ? ", raining" : ""}`,
    `holding ${bot.heldItem?.name ?? "nothing"}`,
    ...(hostiles ? [`hostiles within 16m: ${hostiles}`] : []),
    ...(bot.isSleeping ? ["sleeping"] : []),
  ].join(" | ");
}

/** Full structured status for scripts. */
export function status(bot: Bot) {
  const t = bot.time.timeOfDay;
  return {
    position: point(bot.entity.position),
    dimension: bot.game.dimension,
    health: Math.round(bot.health),
    food: bot.food,
    saturation: Math.round(bot.foodSaturation ?? 0),
    oxygen: bot.oxygenLevel ?? 20,
    xpLevel: bot.experience?.level ?? 0,
    onGround: bot.entity.onGround,
    sleeping: bot.isSleeping,
    time: { timeOfDay: t, day: bot.time.day, phase: dayPhase(t) },
    raining: bot.isRaining,
    biome: bot.blockAt(bot.entity.position)?.biome?.name ?? null,
    equipment: equipment(bot),
    inventory: Object.fromEntries(inventoryCounts(bot)),
    hostilesNearby: Object.fromEntries(nearbyHostiles(bot, 16)),
    sheltered: isSheltered(bot),
  };
}

// ---- Blocks -------------------------------------------------------------------

function harvestToolNames(bot: Bot, block: { harvestTools?: { [k: string]: boolean } }): string[] {
  return Object.keys(block.harvestTools ?? {})
    .map((id) => bot.registry.items[Number(id)]?.name)
    .filter((n): n is string => Boolean(n));
}

/** Details about the block at a position, including state like crop age or door open. */
export function blockInfo(bot: Bot, pos: Pos) {
  const block = bot.blockAt(toVec(pos));
  if (!block) throw new ActionError("NOT_FOUND", `${formatPos(pos)} isn't loaded. Get closer first.`);
  return {
    name: block.name,
    position: point(block.position),
    properties: block.getProperties(),
    solid: block.boundingBox === "block",
    diggable: block.diggable,
    hardness: block.hardness,
    harvestWith: harvestToolNames(bot, block),
    light: { block: block.light, sky: block.skyLight },
    distance: Math.round(distanceTo(bot, block.position) * 10) / 10,
  };
}

const AIRLIKE = /^(air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|large_fern|snow|vine)$/;

/** Whether at least one face of the block is open to air (or leaves you can cut through). */
export function exposed(bot: Bot, pos: Vec3): boolean {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]] as const) {
    const n = bot.blockAt(pos.offset(dx, dy, dz));
    if (!n || AIRLIKE.test(n.name) || n.name.endsWith("_leaves") || n.boundingBox === "empty") return true;
  }
  return false;
}

export interface FindBlocksOptions {
  maxDistance?: number;
  count?: number;
  /** Search around this point instead of the bot. */
  near?: Pos;
  /** Only blocks with an open face (skips ones buried in stone). */
  exposedOnly?: boolean;
}

export function findBlocks(bot: Bot, query: string, options: FindBlocksOptions = {}) {
  const { ids } = resolveBlocks(bot, query);
  const maxDistance = Math.min(options.maxDistance ?? 64, 128);
  const count = Math.min(options.count ?? 10, 200);
  const center = options.near ? toVec(options.near) : bot.entity.position;
  return bot
    .findBlocks({ matching: ids, maxDistance, count: options.exposedOnly ? count * 4 : count, point: center })
    .filter((pos) => !options.exposedOnly || exposed(bot, pos))
    .map((pos) => ({ pos, d: center.distanceTo(pos) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, count)
    .map(({ pos }) => ({
      name: bot.blockAt(pos)?.name ?? "unknown",
      ...point(pos),
      distance: Math.round(distanceTo(bot, pos)),
    }));
}

// ---- Entities -----------------------------------------------------------------

export type EntityKind = "hostile" | "animal" | "passive" | "player" | "item" | "other";

function kindOf(entity: Entity): EntityKind {
  // minecraft-data uses more categories than prismarine-entity's type union declares.
  const type = entity.type as string;
  if (type === "player") return "player";
  if (entity.name === "item") return "item";
  if (isHostile(entity)) return "hostile";
  if (type === "animal") return "animal";
  if (type === "passive" || type === "ambient" || type === "water_creature" || type === "mob") return "passive";
  return "other";
}

export interface FindEntitiesOptions {
  kind?: EntityKind;
  name?: string;
  maxDistance?: number;
  count?: number;
}

export function findEntities(bot: Bot, options: FindEntitiesOptions = {}) {
  const maxDistance = options.maxDistance ?? 32;
  const name = options.name ? normalizeName(options.name) : null;
  return Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.isValid)
    // Spectators (like the supervisor) aren't really in the world.
    .filter((e) => !(e.type === "player" && bot.players[e.username ?? ""]?.gamemode === 3))
    .filter((e) => !options.kind || kindOf(e) === options.kind)
    .filter((e) => !name || e.name === name || e.username?.toLowerCase() === name || dropName(e) === name)
    .map((e) => ({ e, d: distanceTo(bot, e.position) }))
    .filter(({ d }) => d <= maxDistance)
    .sort((a, b) => a.d - b.d)
    .slice(0, options.count ?? 20)
    .map(({ e, d }) => ({
      id: e.id,
      name: e.type === "player" ? e.username : e.name,
      kind: kindOf(e),
      ...point(e.position),
      distance: Math.round(d * 10) / 10,
      ...(e.name === "item" ? { item: dropName(e), count: dropCount(e) } : {}),
    }));
}

function dropped(entity: Entity) {
  return (entity as Entity & { getDroppedItem?: () => { name: string; count: number } | null }).getDroppedItem?.() ?? null;
}
function dropName(entity: Entity) {
  return entity.name === "item" ? (dropped(entity)?.name ?? null) : null;
}
function dropCount(entity: Entity) {
  return dropped(entity)?.count ?? null;
}

// ---- Area scans ---------------------------------------------------------------

/**
 * A compact top-down map around a point: the surface block in each column and its
 * height relative to the center. North (-z) is up, east (+x) is right.
 */
export function scanSurface(bot: Bot, center: Pos, radius: number): string {
  const r = Math.min(Math.max(radius, 2), 16);
  const c = toVec(center);
  const legend = new Map<string, string>();
  const symbols = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const symbolFor = (name: string) => {
    if (!legend.has(name)) legend.set(name, symbols[legend.size] ?? "?");
    return legend.get(name)!;
  };
  const surface: string[] = [];
  const heights: string[] = [];
  for (let dz = -r; dz <= r; dz++) {
    let row = "";
    let hrow = "";
    for (let dx = -r; dx <= r; dx++) {
      let found: Block | null = null;
      for (let dy = 12; dy >= -20; dy--) {
        const b = bot.blockAt(c.offset(dx, dy, dz));
        if (b && b.name !== "air" && b.name !== "cave_air" && !/short_grass|tall_grass|fern|flower|petals|bush/.test(b.name)) {
          found = b;
          break;
        }
      }
      if (dx === 0 && dz === 0) {
        row += "@";
      } else {
        row += found ? symbolFor(found.name) : " ";
      }
      const rel = found ? found.position.y - c.y + 1 : NaN; // +1: the surface you'd stand on vs your feet
      hrow += Number.isNaN(rel) ? " " : rel === 0 ? "=" : rel > 0 ? (rel > 9 ? "^" : String(rel)) : rel < -9 ? "v" : "abcdefghi"[-rel - 1]!;
    }
    surface.push(row);
    heights.push(hrow);
  }
  const key = [...legend].map(([name, s]) => `${s}=${name}`).join(" ");
  return [
    `Surface around ${formatPos(c)} (radius ${r}; north is up, east is right; @ = you):`,
    ...surface,
    `Legend: ${key}`,
    `Height of the walkable surface vs your feet ("=" same, 1-9 higher, a-i lower by 1-9, ^/v 10+):`,
    ...heights,
  ].join("\n");
}

/** One horizontal slice of blocks at height y, for building or digging plans. */
export function scanLayer(bot: Bot, center: Pos, radius: number, y: number): string {
  const r = Math.min(Math.max(radius, 2), 16);
  const legend = new Map<string, string>([["air", "."]]);
  const symbols = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const rows: string[] = [];
  for (let dz = -r; dz <= r; dz++) {
    let row = "";
    for (let dx = -r; dx <= r; dx++) {
      const b = bot.blockAt(new Vec3(Math.floor(center.x) + dx, y, Math.floor(center.z) + dz));
      const name = !b ? "?" : /^(air|cave_air|void_air)$/.test(b.name) ? "air" : b.name;
      if (!legend.has(name)) legend.set(name, symbols[legend.size - 1] ?? "?");
      row += legend.get(name);
    }
    rows.push(row);
  }
  return [
    `Blocks at y=${y} around x ${Math.floor(center.x)}, z ${Math.floor(center.z)} (radius ${r}; north is up, east is right):`,
    ...rows,
    `Legend: ${[...legend].map(([name, s]) => `${s}=${name}`).join(" ")}`,
  ].join("\n");
}

// ---- Overview -----------------------------------------------------------------

const NOTABLE_BLOCK = /(_log|_ore)$|^(crafting_table|furnace|chest|barrel|water|lava)$|_bed$/;

/** A readable picture of the bot's surroundings for the observe tool. */
export function describeSurroundings(bot: Bot, radius: number): string {
  const lines = [`Status: ${statusLine(bot)}`, `Dimension: ${bot.game.dimension}`];
  const here = bot.blockAt(bot.entity.position);
  if (here?.biome?.name) lines.push(`Biome: ${here.biome.name}`);
  lines.push(`Standing on: ${bot.blockAt(bot.entity.position.offset(0, -1, 0))?.name ?? "unknown"}`);
  lines.push(`Inventory: ${inventorySummary(bot)}`);
  const eq = equipment(bot);
  const worn = [eq.head, eq.torso, eq.legs, eq.feet].filter(Boolean);
  if (worn.length) lines.push(`Wearing: ${worn.join(", ")}`);

  const creatures = new Map<string, { count: number; nearest: number }>();
  let drops = 0;
  for (const e of findEntities(bot, { maxDistance: radius, count: 200 })) {
    if (e.kind === "item") {
      drops++;
      continue;
    }
    const label = e.kind === "hostile" ? `${e.name} (hostile)` : String(e.name);
    const entry = creatures.get(label) ?? { count: 0, nearest: Infinity };
    entry.count++;
    entry.nearest = Math.min(entry.nearest, e.distance);
    creatures.set(label, entry);
  }
  const list = [...creatures].sort((a, b) => a[1].nearest - b[1].nearest);
  lines.push(`Creatures: ${list.length ? list.map(([n, c]) => `${n} x${c.count} (nearest ${c.nearest.toFixed(0)}m)`).join(", ") : "none"}`);
  if (drops) lines.push(`Dropped items nearby: ${drops}`);

  const ids = Object.values(bot.registry.blocksByName).filter((b) => NOTABLE_BLOCK.test(b.name)).map((b) => b.id);
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 500 });
  const blocks = new Map<string, { count: number; nearest: Vec3; d: number }>();
  for (const pos of found) {
    const block = bot.blockAt(pos);
    if (!block) continue;
    const d = distanceTo(bot, pos);
    const entry = blocks.get(block.name);
    if (!entry) blocks.set(block.name, { count: 1, nearest: pos, d });
    else {
      entry.count++;
      if (d < entry.d) Object.assign(entry, { nearest: pos, d });
    }
  }
  const blockList = [...blocks].sort((a, b) => a[1].d - b[1].d);
  lines.push(
    `Notable blocks within ${radius}m: ${
      blockList.length ? blockList.map(([n, b]) => `${n} x${b.count} (nearest ${formatPos(b.nearest)}, ${b.d.toFixed(0)}m)`).join("; ") : "none"
    }`,
  );
  if (found.length >= 500) lines.push("(Block scan hit its cap; counts are lower bounds.)");
  lines.push(isSheltered(bot) ? "You're in an enclosed shelter." : "You're out in the open.");
  return lines.join("\n");
}
