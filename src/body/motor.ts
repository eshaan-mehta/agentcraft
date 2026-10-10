// Motor primitives: one level above raw packets, each finishing reliably and
// reporting what changed. Built-in skills and agent-written scripts compose these.
import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { setTimeout as sleep } from "node:timers/promises";
import { Vec3 } from "vec3";
import { ActionError, Interrupted, abortError, errorText } from "../errors.js";
import type { Memory } from "../world/memory.js";
import {
  bestWeapon,
  countById,
  distanceTo,
  foods,
  formatPos,
  inventoryCounts,
  inventoryDiff,
  inventorySummary,
  itemByName,
  normalizeName,
  point,
  toVec,
  type Pos,
} from "../world/perception.js";
import { Navigator, REACH, type NavOptions, type Target } from "./navigation.js";

type Block = NonNullable<ReturnType<Bot["blockAt"]>>;
type Entity = Bot["entity"];
type Item = NonNullable<Bot["heldItem"]>;
type Signal = AbortSignal | undefined;

const { goals } = pathfinderPkg;
const EYE_HEIGHT = 1.62;

/** Awaits a game action, cancelling it when the signal fires or the action overruns its time. */
export function guard<T>(bot: Bot, action: Promise<T>, signal: Signal, timeoutMs: number, what: string): Promise<T> {
  action.catch(() => {}); // observed below; never leave it unhandled
  const timeout = AbortSignal.timeout(Math.max(1, Math.round(timeoutMs)));
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      bot.pathfinder.setGoal(null);
      bot.stopDigging();
      bot.clearControlStates();
      reject(timeout.aborted ? new ActionError("TIMEOUT", `${what} took longer than ${Math.round(timeoutMs / 1000)}s.`) : abortError(combined));
    };
    if (combined.aborted) return onAbort();
    combined.addEventListener("abort", onAbort, { once: true });
    action.then(
      (value) => {
        combined.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        combined.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** Waits, unless the signal fires first. */
export async function pause(ms: number, signal?: Signal) {
  try {
    await sleep(ms, undefined, { signal });
  } catch {
    throw abortError(signal!);
  }
}

/** Waits for a sleeping bot to wake up (morning, or something attacked); false if it's still asleep after `ms`. */
export function wokeWithin(bot: Bot, ms: number, signal: Signal): Promise<boolean> {
  if (!bot.isSleeping) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const finish = (woke: boolean | null) => {
      clearTimeout(timer);
      bot.off("wake", onWake);
      signal?.removeEventListener("abort", onAbort);
      if (woke === null) reject(abortError(signal!));
      else resolve(woke);
    };
    // The new time of day arrives up to a second after the wake-up; wait for it, so
    // whoever checks the time next doesn't see the night that just ended.
    const onWake = () => {
      clearTimeout(timer);
      const fallback = setTimeout(() => finish(true), 1_500);
      bot.once("time", () => {
        clearTimeout(fallback);
        finish(true);
      });
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(false), ms);
    bot.once("wake", onWake);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Asks the server to resend the inventory. Mineflayer leaves the last click of some
 * window operations unconfirmed (2x2 crafting, container moves), so its model of the
 * inventory drifts and the next operation misplaces items.
 */
export async function syncInventory(bot: Bot) {
  const sync = (bot as Bot & { _syncWindow?: (window: unknown) => Promise<void> })._syncWindow;
  if (sync) await Promise.race([sync(bot.inventory), sleep(2_000)]);
}

const REPLACEABLE = new Set([
  "air", "cave_air", "void_air", "water", "lava", "short_grass", "grass", "tall_grass",
  "fern", "large_fern", "dead_bush", "snow", "vine", "seagrass", "tall_seagrass",
]);
const EMPTY = /^(air|cave_air|void_air|water|lava)$/;

// Placement prefers resting on the block below, then the sides, then the block above.
const NEIGHBORS = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)];

// Furnace fuels in order of preference, with how many items each unit smelts.
const FUELS: [RegExp, number][] = [
  [/^coal_block$/, 80],
  [/^(coal|charcoal)$/, 8],
  [/(_log|_wood|_planks)$/, 1.5],
  [/^stick$/, 0.5],
];

const KEEP_ON_DEPOSIT = /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$|^(shield|bow|crossbow|trident|arrow|torch)$/;

/** Milliseconds between full-strength swings with what's in hand. */
function swingCooldown(item: string | undefined): number {
  if (item?.endsWith("_sword")) return 625;
  if (item?.endsWith("_pickaxe")) return 850;
  if (item?.endsWith("_shovel")) return 1_000;
  if (item?.endsWith("_axe")) return 1_100;
  if (item === "trident") return 910;
  return 300; // fists, blocks, and anything else swing 4 times a second
}

export type FightResult = "killed" | "timeout" | "unreachable" | "lost" | "low_health" | "stopped";
export type Slot = "hand" | "off-hand" | "head" | "torso" | "legs" | "feet";

export class Motor {
  constructor(
    readonly bot: Bot,
    readonly nav: Navigator,
    private readonly memory: Memory,
  ) {}

  // ---- Movement ---------------------------------------------------------------

  goTo(target: Target, options: NavOptions = {}) {
    return this.nav.go(target, options);
  }

  /** Climbs out from underground to the height of the open ground above, digging a staircase if needed. */
  async goToSurface(signal: Signal) {
    const bot = this.bot;
    const here = bot.entity.position.floored();
    const game = bot.game as { minY?: number; height?: number }; // set by mineflayer, missing from its types
    const top = (game.minY ?? -64) + (game.height ?? 384);
    // The highest solid block in this column, not counting trees.
    let surface = here.y;
    for (let y = Math.min(top - 1, here.y + 160); y > here.y + 1; y--) {
      const block = bot.blockAt(new Vec3(here.x, y, here.z));
      if (block?.boundingBox === "block" && !/_(leaves|log|wood)$/.test(block.name)) {
        surface = y + 1;
        break;
      }
    }
    if (surface <= here.y) return `Already at the surface: nothing solid above ${formatPos(here)}.`;
    const arrival = await this.nav.go({ y: surface }, { signal, timeoutMs: 180_000 });
    return `Climbed from ${formatPos(here)} up to the surface at ${arrival.position} in ${arrival.seconds}s.`;
  }

  inReach(pos: Pos): boolean {
    const center = new Vec3(Math.floor(pos.x) + 0.5, Math.floor(pos.y) + 0.5, Math.floor(pos.z) + 0.5);
    return this.bot.entity.position.offset(0, EYE_HEIGHT, 0).distanceTo(center) <= REACH;
  }

  /** Walks until a block is within arm's reach, if it isn't already. */
  async approach(pos: Pos, signal: Signal) {
    if (!this.inReach(pos)) await this.nav.go({ reach: pos }, { signal });
  }

  async lookAt(pos: Pos) {
    await this.bot.lookAt(new Vec3(pos.x, pos.y, pos.z), true);
  }

  async controls(states: Partial<Record<"forward" | "back" | "left" | "right" | "jump" | "sprint" | "sneak", boolean>>, ms: number, signal: Signal) {
    for (const [key, on] of Object.entries(states)) this.bot.setControlState(key as "forward", Boolean(on));
    try {
      await pause(Math.min(ms, 10_000), signal);
    } finally {
      for (const key of Object.keys(states)) this.bot.setControlState(key as "forward", false);
    }
    return `Held ${Object.keys(states).join("+")} for ${ms}ms; now at ${formatPos(this.bot.entity.position)}.`;
  }

  // ---- Blocks -----------------------------------------------------------------

  blockAt(pos: Pos): Block {
    const block = this.bot.blockAt(toVec(pos));
    if (!block) throw new ActionError("NOT_FOUND", `${formatPos(pos)} isn't loaded. Get closer first.`);
    return block;
  }

  /** Why mining a block would yield nothing, or null if a tool on hand (or a hand) will do. */
  harvestProblem(block: Block): string | null {
    const tools = block.harvestTools;
    if (!tools || this.bot.inventory.items().some((i) => tools[i.type])) return null;
    const names = Object.keys(tools).map((id) => this.bot.registry.items[Number(id)]?.name).filter(Boolean);
    return `${block.name} drops nothing unless mined with one of: ${names.join(", ")}`;
  }

  /** Mines a block (walking within reach first) and picks up what drops. */
  async dig(pos: Pos, signal: Signal, options: { collect?: boolean; requireDrop?: boolean } = {}) {
    let block = this.blockAt(pos);
    if (EMPTY.test(block.name)) throw new ActionError("INVALID", `There's nothing to dig at ${formatPos(pos)} (${block.name}).`);
    if (!block.diggable) throw new ActionError("INVALID", `${block.name} at ${formatPos(pos)} can't be mined.`);
    const problem = this.harvestProblem(block);
    if (problem && options.requireDrop) throw new ActionError("MISSING_TOOL", `${problem}.`);
    await this.approach(pos, signal);
    block = this.blockAt(pos);
    const before = inventoryCounts(this.bot);
    const tool = this.bot.pathfinder.bestHarvestTool(block);
    if (tool) await this.bot.equip(tool, "hand");
    try {
      await guard(this.bot, this.bot.dig(block, true), signal, this.bot.digTime(block) + 5_000, `Digging ${block.name}`);
    } catch (err) {
      if (err instanceof Interrupted || err instanceof ActionError) throw err;
      throw new ActionError("FAILED", `Couldn't dig ${block.name} at ${formatPos(pos)}: ${errorText(err)}`);
    }
    if (options.collect !== false) await this.collectDrops(block.position, 5, signal);
    return {
      mined: block.name,
      change: inventoryDiff(before, inventoryCounts(this.bot)),
      ...(problem ? { warning: `${problem}, so it dropped nothing.` } : {}),
    };
  }

  /** Walks to and picks up dropped items near a point. Skips ones it can't reach. */
  async collectDrops(near: Pos, radius: number, signal: Signal) {
    await pause(350, signal); // let drops spawn and settle
    const center = new Vec3(near.x, near.y, near.z);
    const skipped = new Set<number>();
    const deadline = Date.now() + 20_000;
    let rechecked = false;
    while (Date.now() < deadline) {
      const drop = Object.values(this.bot.entities)
        .filter((e) => e.name === "item" && e.isValid && !skipped.has(e.id) && e.position.distanceTo(center) <= radius)
        .sort((a, b) => distanceTo(this.bot, a.position) - distanceTo(this.bot, b.position))[0];
      if (!drop) {
        // Drops sometimes appear a moment late; look once more before giving up.
        if (rechecked) return;
        rechecked = true;
        await pause(500, signal);
        continue;
      }
      try {
        await this.nav.go({ x: drop.position.x, y: drop.position.y, z: drop.position.z, range: 1 }, { signal, timeoutMs: 10_000 });
        // Freshly dropped items can't be picked up for a moment.
        for (let i = 0; i < 8 && drop.isValid; i++) await pause(150, signal);
        if (drop.isValid) skipped.add(drop.id);
      } catch (err) {
        if (err instanceof Interrupted) throw err;
        skipped.add(drop.id);
      }
    }
  }

  /**
   * Places an item at a position against any solid neighbor, walking within reach and
   * stepping out of the spot first. Clears a flower or other non-solid plant in the way.
   */
  async place(item: string, pos: Pos, signal: Signal): Promise<string> {
    const stack = this.inventoryItem(item);
    const target = toVec(pos);
    const existing = this.blockAt(target);
    const clearable = existing.boundingBox === "empty" && existing.diggable && !/water|lava/.test(existing.name);
    if (!REPLACEABLE.has(existing.name) && !clearable) {
      throw new ActionError("BLOCKED", `${formatPos(target)} is occupied by ${existing.name}. Dig it first or pick another spot.`);
    }
    if (!NEIGHBORS.some((offset) => this.bot.blockAt(target.plus(offset))?.boundingBox === "block")) {
      throw new ActionError("BLOCKED", `Nothing solid next to ${formatPos(target)} to place against. Place a supporting block first.`);
    }
    await this.approach(target, signal);
    const feet = this.bot.entity.position.floored();
    if (feet.equals(target) || feet.offset(0, 1, 0).equals(target)) {
      await this.nav.go({ awayFrom: point(target), distance: 1.5 }, { signal, timeoutMs: 10_000 });
      await this.approach(target, signal);
    }
    const placed = await this.placeInReach(stack.type, target, signal);
    const lid = /chest$/.test(placed) ? this.solidLid(target) : null;
    return lid ? `${placed} (warning: the ${lid} on top will stop it opening; dig that out or place it elsewhere)` : placed;
  }

  /** The solid block sitting on top of a chest (which stops it opening), or null. */
  private solidLid(chest: Pos): string | null {
    const above = this.bot.blockAt(toVec(chest).offset(0, 1, 0));
    if (!above || above.boundingBox !== "block") return null;
    // These let a chest open even when they're on top of it.
    return /glass|leaves|slab|stairs|fence|chest|sign|torch|carpet|trapdoor|_wall$/.test(above.name) ? null : above.name;
  }

  /** Places a block of `itemType` at `target`; the bot must already be within reach and out of the way. */
  async placeInReach(itemType: number, target: Vec3, signal: Signal): Promise<string> {
    const existing = this.blockAt(target);
    if (!REPLACEABLE.has(existing.name)) {
      const clearable = existing.boundingBox === "empty" && existing.diggable && !/water|lava/.test(existing.name);
      if (!clearable) throw new ActionError("BLOCKED", `${formatPos(target)} is occupied by ${existing.name}.`);
      await guard(this.bot, this.bot.dig(existing, true), signal, 5_000, `Clearing ${existing.name}`);
    }
    const reference = NEIGHBORS.map((offset) => ({ block: this.bot.blockAt(target.plus(offset)), face: offset.scaled(-1) })).find(
      (r) => r.block?.boundingBox === "block",
    );
    if (!reference?.block) throw new ActionError("BLOCKED", `Nothing solid next to ${formatPos(target)} to place against.`);
    const stack = this.bot.inventory.items().find((i) => i.type === itemType);
    if (!stack) throw new ActionError("MISSING_ITEMS", `Ran out of ${this.bot.registry.items[itemType]?.name}.`);

    const previous = this.bot.blockAt(target)?.name;
    await this.bot.equip(stack, "hand");
    let placeError = "";
    try {
      await guard(this.bot, this.bot.placeBlock(reference.block, reference.face), signal, 5_000, "Placing");
    } catch (err) {
      if (err instanceof Interrupted) throw err;
      placeError = errorText(err);
    }
    const now = this.bot.blockAt(target);
    if (!now || now.name === previous) {
      throw new ActionError("FAILED", `Placing at ${formatPos(target)} didn't work${placeError ? `: ${placeError}` : ""}. Try standing elsewhere or another spot.`);
    }
    await syncInventory(this.bot);
    return now.name;
  }

  /** A free spot within a few blocks to put a crafting table, furnace, or chest. */
  findPlacementSpot(): Vec3 | null {
    const feet = this.bot.entity.position.floored();
    for (const r of [1, 2, 3]) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          for (const dy of [0, 1, -1]) {
            const cell = feet.offset(dx, dy, dz);
            const at = this.bot.blockAt(cell);
            const below = this.bot.blockAt(cell.offset(0, -1, 0));
            const above = this.bot.blockAt(cell.offset(0, 1, 0));
            // Headroom matters: a chest with a solid block on top won't open.
            if (at && REPLACEABLE.has(at.name) && !/water|lava/.test(at.name) && below?.boundingBox === "block" && above && REPLACEABLE.has(above.name)) return cell;
          }
        }
      }
    }
    return null;
  }

  /**
   * Right-clicks a block, optionally holding an item: opens doors and gates, flips
   * levers, presses buttons, tills dirt with a hoe, plants seeds, uses bone meal,
   * fills or empties a bucket.
   */
  async useBlock(pos: Pos, item: string | undefined, signal: Signal): Promise<string> {
    const block = this.blockAt(pos);
    await this.approach(pos, signal);
    if (item) await this.bot.equip(this.inventoryItem(item), "hand");
    const before = `${block.name} ${JSON.stringify(block.getProperties())}`;
    // Buckets work by line of sight, so aim at the top surface: aimed at a pool's middle
    // from the bank, the line passes through the bank first and the bucket stays empty.
    const aim = item?.endsWith("bucket") ? 0.9 : 0.5;
    await this.bot.lookAt(block.position.offset(0.5, aim, 0.5), true);
    await this.bot.waitForTicks(2); // the server needs to see where we're looking
    if (item?.endsWith("bucket")) {
      // Buckets act on whatever fluid or surface you're looking at, not the block itself.
      this.bot.activateItem();
      await pause(200, signal);
      this.bot.deactivateItem();
    } else {
      await guard(this.bot, this.bot.activateBlock(block), signal, 5_000, `Using ${block.name}`);
    }
    await pause(250, signal);
    if (item?.endsWith("bucket")) {
      // A bucket changes what's in your hand, not the block you aimed at.
      const held = this.bot.heldItem?.name ?? "nothing";
      const used = normalizeName(item);
      if (held === used) {
        return `The ${used} didn't do anything at ${formatPos(pos)}. To fill a bucket, aim at a still source block (not flowing water) whose surface you can see, within reach; to pour, aim at a solid block's face.`;
      }
      return used === "bucket" ? `Filled the bucket: now holding ${held}.` : `Poured the ${used} out against ${block.name} at ${formatPos(pos)}; now holding ${held}.`;
    }
    const now = this.blockAt(pos);
    const after = `${now.name} ${JSON.stringify(now.getProperties())}`;
    return `Used ${block.name} at ${formatPos(pos)}${item ? ` with ${normalizeName(item)}` : ""}. ${before === after ? "The block didn't change." : `Now: ${after}.`}${
      item ? ` Holding ${this.bot.heldItem?.name ?? "nothing"} x${this.bot.heldItem?.count ?? 0}.` : ""
    }`;
  }

  // ---- Items ------------------------------------------------------------------

  inventoryItem(name: string): Item {
    const key = normalizeName(name);
    const item = this.bot.inventory.items().find((i) => i.name === key);
    if (!item) throw new ActionError("MISSING_ITEMS", `You don't have any ${key}. Inventory: ${inventorySummary(this.bot)}.`);
    return item;
  }

  async equip(item: string, slot: Slot = "hand") {
    await this.bot.equip(this.inventoryItem(item), slot);
    return `Equipped ${normalizeName(item)} (${slot}).`;
  }

  async unequip(slot: Slot) {
    await this.bot.unequip(slot);
    return `Emptied ${slot}.`;
  }

  /** Right-clicks the air with an item: throw, drink, block with a shield, draw and loose a bow (holdMs). */
  async useItem(item: string | undefined, holdMs: number, signal: Signal) {
    if (item) await this.bot.equip(this.inventoryItem(item), "hand");
    const held = this.bot.heldItem?.name ?? "nothing";
    this.bot.activateItem();
    try {
      await pause(Math.max(holdMs, 100), signal);
    } finally {
      this.bot.deactivateItem();
    }
    return `Used ${held}${holdMs > 100 ? ` for ${holdMs}ms` : ""}.`;
  }

  async toss(item: string, count: number | undefined) {
    const stack = this.inventoryItem(item);
    const amount = Math.min(count ?? Infinity, countById(this.bot, stack.type));
    await this.bot.toss(stack.type, null, amount);
    await syncInventory(this.bot);
    return `Dropped ${amount} ${stack.name}.`;
  }

  /** Eats a food item, then goes back to holding whatever was in hand before. */
  async eat(item?: string) {
    if (this.bot.food >= 20) throw new ActionError("INVALID", "Not hungry (food 20/20); you can't eat when full.");
    const food = item ? this.inventoryItem(item) : foods(this.bot)[0];
    if (!food) throw new ActionError("MISSING_ITEMS", `No food in the inventory. Inventory: ${inventorySummary(this.bot)}.`);
    const previous = this.bot.heldItem;
    await this.bot.equip(food, "hand");
    await this.bot.consume();
    if (previous && previous.type !== food.type) {
      const again = this.bot.inventory.items().find((i) => i.type === previous.type);
      if (again) await this.bot.equip(again, "hand").catch(() => {});
    }
    return `Ate ${food.name}. Food ${this.bot.food}/20, health ${Math.round(this.bot.health)}/20.`;
  }

  // ---- Entities ---------------------------------------------------------------

  entity(id: number): Entity {
    const entity = this.bot.entities[id];
    if (!entity?.isValid) throw new ActionError("NOT_FOUND", `Entity ${id} isn't around anymore.`);
    return entity;
  }

  /**
   * Chases and hits an entity with the best weapon on hand until it dies, gets away,
   * can't be reached (no closer for 8s), time runs out, health drops to `stopAtHealth`,
   * or `stopIf` says something more urgent came up.
   */
  async fight(target: Entity, options: { signal?: Signal; timeoutMs: number; stopAtHealth?: number; stopIf?: () => boolean }): Promise<FightResult> {
    const bot = this.bot;
    const weapon = bestWeapon(bot);
    if (weapon && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, "hand");
    const chase = new goals.GoalFollow(target, 1.5);
    const deadline = Date.now() + options.timeoutMs;
    // "Got away" means it's getting farther than it started, not just far (hunt picks targets up to 48 blocks off).
    const lostAt = Math.max(24, distanceTo(bot, target.position) + 12);
    let closest = Infinity;
    let lastProgress = Date.now();
    try {
      while (target.isValid) {
        if (options.signal?.aborted) throw abortError(options.signal);
        // Re-assert the chase each round: a just-cancelled action can clear the goal late.
        if (bot.pathfinder.goal !== chase) bot.pathfinder.setGoal(chase, true);
        if (Date.now() > deadline) return "timeout";
        if (options.stopAtHealth !== undefined && bot.health <= options.stopAtHealth) return "low_health";
        if (options.stopIf?.()) return "stopped";
        const d = distanceTo(bot, target.position);
        if (d > lostAt) return "lost";
        if (d < closest - 0.5) {
          closest = d;
          lastProgress = Date.now();
        }
        if (d > 3.5 && Date.now() - lastProgress > 8_000) return "unreachable";
        if (d <= 3.5) {
          lastProgress = Date.now();
          await bot.lookAt(target.position.offset(0, target.height * 0.85, 0), true);
          bot.attack(target);
        }
        await sleep(swingCooldown(bot.heldItem?.name));
      }
      // The target also vanishes when *we* die and respawn; that isn't a kill.
      if (options.signal?.aborted) throw abortError(options.signal);
      return "killed";
    } finally {
      bot.pathfinder.setGoal(null);
    }
  }

  /** Right-clicks a mob or object: shear, milk, breed (holding the food), feed, mount, trade. */
  async interact(id: number, item: string | undefined, signal: Signal) {
    const entity = this.entity(id);
    if (distanceTo(this.bot, entity.position) > 3) await this.nav.go({ entity, range: 2 }, { signal });
    if (item) await this.bot.equip(this.inventoryItem(item), "hand");
    await this.bot.lookAt(entity.position.offset(0, entity.height * 0.7, 0), true);
    await this.bot.waitForTicks(2);
    const before = inventoryCounts(this.bot);
    await guard(this.bot, Promise.resolve(this.bot.activateEntity(entity)), signal, 5_000, `Interacting with ${entity.name}`);
    await pause(400, signal);
    return `Right-clicked ${entity.name}${item ? ` with ${normalizeName(item)}` : ""}. Inventory change: ${inventoryDiff(before, inventoryCounts(this.bot))}.`;
  }

  async mount(id: number, signal: Signal) {
    const entity = this.entity(id);
    if (distanceTo(this.bot, entity.position) > 3) await this.nav.go({ entity, range: 2 }, { signal });
    this.bot.mount(entity);
    await pause(500, signal);
    return this.vehicle() ? `Riding ${entity.name}.` : `Couldn't mount ${entity.name}.`;
  }

  // Mineflayer tracks this but its type definitions don't declare it.
  private vehicle(): unknown {
    return (this.bot as Bot & { vehicle?: unknown }).vehicle;
  }

  async dismount() {
    if (!this.vehicle()) return "Not riding anything.";
    this.bot.dismount();
    return "Dismounted.";
  }

  // ---- Crafting and smelting ---------------------------------------------------

  nearestBlock(names: string[], maxDistance = 32): Block | null {
    const ids = names.map((n) => this.bot.registry.blocksByName[n]?.id).filter((id): id is number => id !== undefined);
    const nearest = this.bot
      .findBlocks({ matching: ids, maxDistance, count: 16 })
      .sort((a, b) => distanceTo(this.bot, a) - distanceTo(this.bot, b))[0];
    return nearest ? this.bot.blockAt(nearest) : null;
  }

  /** Crafts one item directly from what's in the inventory (no intermediate steps). */
  async craft(item: string, count: number, signal: Signal) {
    const bot = this.bot;
    const target = itemByName(bot, item);
    const table = this.nearestBlock(["crafting_table"]);
    const recipe = bot.recipesFor(target.id, null, 1, table ?? null)[0];
    if (!recipe) throw new ActionError("MISSING_ITEMS", this.explainMissing(target.id, target.name, table !== null));
    const wanted = Math.ceil(count / recipe.result.count);
    const affordable = Math.min(...recipe.delta.filter((d) => d.count < 0).map((d) => Math.floor(countById(bot, d.id) / -d.count)));
    const runs = Math.min(wanted, affordable);
    if (recipe.requiresTable && table) await this.approach(table.position, signal);
    const before = inventoryCounts(bot);
    try {
      await guard(bot, bot.craft(recipe, runs, recipe.requiresTable ? table! : undefined), signal, 30_000, "Crafting");
    } catch (err) {
      if (err instanceof Interrupted || err instanceof ActionError) throw err;
      throw new ActionError("FAILED", `Crafting ${target.name} failed: ${errorText(err)}`);
    } finally {
      await syncInventory(bot);
    }
    const made = runs * recipe.result.count;
    return {
      crafted: made,
      change: inventoryDiff(before, inventoryCounts(bot)),
      ...(runs < wanted ? { shortBy: `Only had ingredients for ${made} of the ${count} requested.` } : {}),
    };
  }

  private explainMissing(id: number, name: string, hasTable: boolean): string {
    const bot = this.bot;
    const recipes = bot.recipesAll(id, null, true);
    if (!recipes.length) return `${name} has no crafting recipe. It may need smelting, or it's found or mined instead.`;
    const options = recipes
      .map((recipe) => {
        const needs = recipe.delta
          .filter((d) => d.count < 0)
          .map((d) => ({ name: bot.registry.items[d.id]!.name, need: -d.count, have: countById(bot, d.id) }));
        return { recipe, needs, missing: needs.filter((n) => n.have < n.need) };
      })
      .sort((a, b) => a.missing.length - b.missing.length);
    const best = options[0]!;
    if (best.missing.length === 0 && best.recipe.requiresTable && !hasTable) {
      return `${name} needs a crafting table within 32 blocks. Place one (craft it from 4 planks) and try again.`;
    }
    const uses = best.needs.map((n) => `${n.need} ${n.name}`).join(", ");
    const short = best.missing.map((n) => `${n.need - n.have} ${n.name}`).join(", ");
    return `Missing ingredients for ${name}. One recipe uses ${uses}${best.recipe.requiresTable ? " at a crafting table" : ""}; you're short ${short}.`;
  }

  /** Smelts items in the nearest furnace, adding fuel from the inventory if needed. */
  /**
   * Loads a furnace and smelts. One item is waited for; a bigger batch is left cooking
   * (about 10s an item) so the bot can do something else, unless `wait` is set
   * (crafting needs the result right away). collectSmelted picks it up later.
   */
  async smelt(item: string, count: number, signal: Signal, options: { wait?: boolean } = {}) {
    const bot = this.bot;
    const input = itemByName(bot, item);
    const have = countById(bot, input.id);
    if (!have) throw new ActionError("MISSING_ITEMS", `You don't have any ${input.name}.`);
    const amount = Math.min(count, have);
    const furnaceBlock = this.nearestBlock(["furnace"]);
    if (!furnaceBlock) throw new ActionError("MISSING_ITEMS", "No furnace within 32 blocks. Place one (craft it from 8 cobblestone).");
    await this.approach(furnaceBlock.position, signal);

    const before = inventoryCounts(bot);
    const furnace = await bot.openFurnace(furnaceBlock);
    let left = 0;
    let cooking = "";
    try {
      if (furnace.outputItem()) await furnace.takeOutput();
      const queued = furnace.inputItem();
      if (queued && queued.type !== input.id) throw new ActionError("BLOCKED", `The furnace is busy smelting ${queued.name}.`);
      // An empty fuel slot gets topped up; extra fuel is harmless if it's still burning.
      if (!furnace.fuelItem()) {
        const fuel = bot.inventory
          .items()
          .filter((i) => i.type !== input.id)
          .map((i) => ({ item: i, rank: FUELS.findIndex(([re]) => re.test(i.name)) }))
          .filter((f) => f.rank >= 0)
          .sort((a, b) => a.rank - b.rank)[0];
        if (!fuel) throw new ActionError("MISSING_ITEMS", "No fuel in the inventory (coal, charcoal, logs, planks, or sticks).");
        const units = Math.min(Math.ceil(amount / FUELS[fuel.rank]![1]), countById(bot, fuel.item.type));
        await furnace.putFuel(fuel.item.type, null, units);
      }
      await furnace.putInput(input.id, null, amount);
      if (!options.wait && amount > 1) {
        cooking = `${amount} ${input.name} cooking in the furnace at ${formatPos(furnaceBlock.position)}, ready in about ${amount * 10}s. Do something else meanwhile, then collect_smelted there.`;
      } else {
        const deadline = Date.now() + Math.min(amount * 10_500 + 3_000, 180_000);
        while (Date.now() < deadline && (furnace.outputItem()?.count ?? 0) < amount) await pause(1_000, signal);
        if (furnace.outputItem()) await furnace.takeOutput();
        left = furnace.inputItem()?.count ?? 0;
      }
    } finally {
      furnace.close();
    }
    await syncInventory(bot);
    if (cooking) return { change: inventoryDiff(before, inventoryCounts(bot)), cooking };
    return {
      change: inventoryDiff(before, inventoryCounts(bot)),
      ...(left ? { leftInFurnace: `${left} ${input.name} still in the furnace at ${formatPos(furnaceBlock.position)} (ran out of time or fuel).` } : {}),
    };
  }

  // ---- Containers --------------------------------------------------------------

  /**
   * Lists, deposits into, or withdraws from a chest or barrel (the nearest one unless
   * a position is given). Whatever it sees inside is remembered.
   */
  async container(pos: Pos | undefined, action: "list" | "deposit" | "withdraw", item: string | undefined, count: number | undefined, signal: Signal) {
    const bot = this.bot;
    const block = pos ? this.blockAt(pos) : this.nearestBlock(["chest", "trapped_chest", "barrel"]);
    if (!block || !/chest|barrel/.test(block.name)) {
      throw new ActionError("NOT_FOUND", pos ? `No chest or barrel at ${formatPos(pos)}.` : "No chest or barrel within 32 blocks.");
    }
    const lid = /chest$/.test(block.name) ? this.solidLid(block.position) : null;
    if (lid) {
      throw new ActionError("BLOCKED", `The ${block.name} at ${formatPos(block.position)} can't open: there's ${lid} on top of it. Dig that block out first.`);
    }
    await this.approach(block.position, signal);
    let window: Awaited<ReturnType<Bot["openContainer"]>>;
    try {
      window = await guard(bot, bot.openContainer(block), signal, 10_000, `Opening the ${block.name}`);
    } catch (err) {
      if (err instanceof Interrupted) throw err;
      throw new ActionError("FAILED", `Couldn't open the ${block.name} at ${formatPos(block.position)}: it didn't respond. Make sure nothing is on top of it and try again.`);
    }
    const outcome: string[] = [];
    let contents = new Map<string, number>();
    try {
      if (action === "deposit") {
        const registryFoods = bot.registry.foodsByName;
        const stacks = item ? [this.inventoryItem(item)] : bot.inventory.items().filter((i) => !KEEP_ON_DEPOSIT.test(i.name) && !registryFoods[i.name]);
        if (!stacks.length) throw new ActionError("INVALID", "Nothing to deposit (tools, armor, and food are kept unless named).");
        for (const type of new Set(stacks.map((s) => s.type))) {
          const name = bot.registry.items[type]!.name;
          const amount = Math.min(count ?? Infinity, countById(bot, type));
          try {
            await window.deposit(type, null, amount);
            outcome.push(`deposited ${amount} ${name}`);
          } catch (err) {
            outcome.push(`couldn't deposit ${name} (${errorText(err)})`);
          }
        }
      } else if (action === "withdraw") {
        if (!item) throw new ActionError("INVALID", "Say which item to withdraw.");
        const type = itemByName(bot, item).id;
        const available = window.containerItems().reduce((sum, i) => (i.type === type ? sum + i.count : sum), 0);
        if (!available) throw new ActionError("NOT_FOUND", `The ${block.name} has no ${normalizeName(item)}.`);
        const amount = Math.min(count ?? available, available);
        await window.withdraw(type, null, amount);
        outcome.push(`withdrew ${amount} ${normalizeName(item)}`);
      }
      contents = new Map();
      for (const i of window.containerItems()) contents.set(i.name, (contents.get(i.name) ?? 0) + i.count);
    } finally {
      window.close();
      this.memory.recordContainer(block.position, block.name, Object.fromEntries(contents));
    }
    await syncInventory(bot);
    const listing = [...contents].map(([n, c]) => `${n} x${c}`).join(", ") || "nothing";
    return `${outcome.length ? `${outcome.join("; ")}. ` : ""}${block.name} at ${formatPos(block.position)} holds: ${listing}.`;
  }

  // ---- Rest ---------------------------------------------------------------------

  async sleep(signal: Signal) {
    const names = Object.keys(this.bot.registry.blocksByName).filter((n) => n.endsWith("_bed"));
    const bed = this.nearestBlock(names);
    if (!bed) throw new ActionError("NOT_FOUND", "No bed within 32 blocks. Craft one from 3 wool and 3 planks and place it.");
    await this.approach(bed.position, signal);
    try {
      await this.bot.sleep(bed);
    } catch (err) {
      throw new ActionError("FAILED", `Couldn't sleep: ${errorText(err)}`);
    }
    const where = formatPos(bed.position);
    // The night skips about 5s after every player in the world is in bed.
    if (await wokeWithin(this.bot, 15_000, signal)) {
      return `Slept in the bed at ${where} (respawn point set there). The night passed; it's ${this.bot.time.timeOfDay < 12_000 ? "morning" : "still night: something woke you"}.`;
    }
    const awake = Object.values(this.bot.players)
      .filter((p) => p.username !== this.bot.username && p.gamemode !== 3) // spectators don't count
      .map((p) => p.username);
    return `In bed at ${where} (respawn point set there), but the night isn't passing: it only skips once every player is asleep${
      awake.length ? `, and ${awake.join(", ")} ${awake.length > 1 ? "are" : "is"} up` : ""
    }. Waiting won't make it pass sooner. Stay in bed (you'll wake at sunrise or if attacked), ask the others to sleep too, or get up and do something else.`;
  }

  /** Takes finished items out of a furnace (the nearest, or the one at `pos`) and says what's still cooking. */
  async collectSmelted(pos: Pos | null, signal: Signal) {
    const bot = this.bot;
    const block = pos ? this.blockAt(pos) : this.nearestBlock(["furnace"]);
    if (!block || block.name !== "furnace") throw new ActionError("NOT_FOUND", pos ? `No furnace at ${formatPos(pos)}.` : "No furnace within 32 blocks.");
    await this.approach(block.position, signal);
    const before = inventoryCounts(bot);
    const furnace = await bot.openFurnace(block);
    let still = "";
    try {
      if (furnace.outputItem()) await furnace.takeOutput();
      const input = furnace.inputItem();
      if (input) {
        // The block's own "lit" state; the window's fuel numbers arrive late and out of order.
        const burning = furnace.fuelItem() || String(bot.blockAt(block.position)?.getProperties().lit) === "true";
        still = ` ${input.count} ${input.name} still cooking (about ${input.count * 10}s more)${burning ? "" : ", but the fuel ran out: smelt it again to add fuel"}.`;
      }
    } finally {
      furnace.close();
    }
    await syncInventory(bot);
    const got = inventoryDiff(before, inventoryCounts(bot));
    return `Furnace at ${formatPos(block.position)}: took ${got === "no change" ? "nothing (nothing finished yet)" : got}.${still || " It's empty now."}`;
  }

  /** Fishes until `count` catches, or a few minutes pass, or the fish stop biting. */
  async fish(count: number, signal: Signal) {
    const bot = this.bot;
    const rod = bot.inventory.items().find((i) => i.name === "fishing_rod");
    if (!rod) throw new ActionError("MISSING_ITEMS", "No fishing_rod. Craft one from 3 sticks and 2 string (spiders drop string).");
    // Open water, with water all around, so the cast lands in it rather than on the bank.
    const water = this.bot.registry.blocksByName.water!.id;
    const open = bot
      .findBlocks({ matching: water, maxDistance: 16, count: 200 })
      .filter((p) => bot.blockAt(p.offset(0, 1, 0))?.name === "air")
      .filter((p) => NEIGHBORS.filter((n) => n.y === 0).every((n) => bot.blockAt(p.plus(n))?.name === "water"))
      .sort((a, b) => distanceTo(bot, a) - distanceTo(bot, b))[0];
    if (!open) throw new ActionError("NOT_FOUND", "No open water within 16 blocks to fish in.");
    // Fish from a few blocks off: a long cast drops the catch short, into the water.
    if (distanceTo(bot, open) > 5) await this.nav.go({ x: open.x, y: open.y + 1, z: open.z, range: 4 }, { signal, careful: true });
    await bot.equip(rod, "hand");
    const before = inventoryCounts(bot);
    let caught = 0;
    let misses = 0;
    const deadline = Date.now() + Math.min(count * 45_000, 240_000);
    while (caught < count && misses < 3 && Date.now() < deadline) {
      await bot.lookAt(open.offset(0.5, 0.9, 0.5), true); // at the surface: a short, low cast
      await bot.waitForTicks(2);
      try {
        await guard(bot, bot.fish(), signal, 45_000, "Waiting for a bite");
        caught++;
        // The catch flies to you; grab it if it lands just short, but don't wade out after it.
        await pause(1_200, signal);
        const stand = bot.entity.position.clone();
        await this.collectDrops(stand, 3, signal).catch((err) => {
          if (err instanceof Interrupted) throw err;
        });
        if (distanceTo(bot, stand) > 1.5) await this.nav.go({ x: stand.x, y: stand.y, z: stand.z, range: 1 }, { signal, careful: true }).catch(() => {});
      } catch (err) {
        if (err instanceof Interrupted) {
          bot.activateItem(); // reel the line back in
          throw err;
        }
        misses++;
        bot.activateItem();
        await pause(500, signal);
      }
    }
    await syncInventory(bot);
    const got = inventoryDiff(before, inventoryCounts(bot));
    if (!caught) throw new ActionError("FAILED", `No bites in ${misses} casts at ${formatPos(open)}. Try deeper or bigger open water.`);
    return `Caught ${caught}: ${got}. Cook fish before eating it (smelt).`;
  }

  async wake() {
    if (!this.bot.isSleeping) return "Not sleeping.";
    await this.bot.wake();
    return "Woke up.";
  }
}
