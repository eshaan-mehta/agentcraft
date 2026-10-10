// Game facts from minecraft-data, so plans rest on real recipes, drops, and tool
// tiers rather than the model's memory of them.
import type { Bot } from "mineflayer";
import { ActionError } from "../errors.js";
import { inventoryCounts, itemByName, normalizeName } from "./perception.js";

// Furnace recipes (minecraft-data doesn't include smelting): output <- inputs.
const SMELTING: Record<string, string[]> = {
  iron_ingot: ["raw_iron", "iron_ore", "deepslate_iron_ore"],
  gold_ingot: ["raw_gold", "gold_ore", "deepslate_gold_ore", "nether_gold_ore"],
  copper_ingot: ["raw_copper", "copper_ore", "deepslate_copper_ore"],
  glass: ["sand", "red_sand"],
  stone: ["cobblestone"],
  smooth_stone: ["stone"],
  deepslate: ["cobbled_deepslate"],
  brick: ["clay_ball"],
  nether_brick: ["netherrack"],
  terracotta: ["clay"],
  charcoal: [
    "oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log",
  ],
  cooked_beef: ["beef"],
  cooked_porkchop: ["porkchop"],
  cooked_chicken: ["chicken"],
  cooked_mutton: ["mutton"],
  cooked_rabbit: ["rabbit"],
  cooked_cod: ["cod"],
  cooked_salmon: ["salmon"],
  baked_potato: ["potato"],
  dried_kelp: ["kelp"],
  green_dye: ["cactus"],
  lime_dye: ["sea_pickle"],
  sponge: ["wet_sponge"],
  smooth_sandstone: ["sandstone"],
  smooth_red_sandstone: ["red_sandstone"],
  smooth_quartz: ["quartz_block"],
  cracked_stone_bricks: ["stone_bricks"],
  netherite_scrap: ["ancient_debris"],
  popped_chorus_fruit: ["chorus_fruit"],
  coal: ["coal_ore", "deepslate_coal_ore"],
  diamond: ["diamond_ore", "deepslate_diamond_ore"],
  emerald: ["emerald_ore", "deepslate_emerald_ore"],
  lapis_lazuli: ["lapis_ore", "deepslate_lapis_ore"],
  redstone: ["redstone_ore", "deepslate_redstone_ore"],
  quartz: ["nether_quartz_ore"],
};

// Tie-breakers for recipe variants: prefer materials that are easy to find.
const COMMON = /^(cobblestone|oak_|stick$|iron_ingot$|string$)/;
const UNCOMMON = /deepslate|blackstone|crimson|warped|bamboo|cherry|mangrove|pale_oak|jungle|acacia|dark_oak|nether|copper/;

export const FUELS = ["coal", "charcoal", "coal_block", "blaze_rod", "lava_bucket", "dried_kelp_block", "*_log", "*_planks", "stick"];

const TIERS = ["wooden", "golden", "stone", "copper", "iron", "diamond", "netherite"];

export interface Recipe {
  result: number;
  ingredients: Record<string, number>;
  table: boolean;
}

export interface Step {
  action: "craft" | "smelt";
  item: string;
  count: number;
  table?: boolean;
  from?: string;
}

interface Drop {
  item: string;
  dropChance: number;
  silkTouch?: boolean;
}

export class Knowledge {
  private blockSourceIndex: Map<string, { block: string; chance: number }[]> | null = null;
  private mobSourceIndex: Map<string, { mob: string; chance: number }[]> | null = null;

  constructor(private readonly bot: Bot) {}

  /** Crafting recipes for an item, with duplicate wood-type variants collapsed. */
  recipes(item: string): Recipe[] {
    const target = itemByName(this.bot, item);
    const seen = new Set<string>();
    const out: Recipe[] = [];
    for (const r of this.bot.recipesAll(target.id, null, true)) {
      const ingredients: Record<string, number> = {};
      for (const d of r.delta) {
        if (d.count >= 0) continue;
        const name = this.bot.registry.items[d.id]?.name;
        if (name) ingredients[name] = (ingredients[name] ?? 0) - d.count;
      }
      const key = `${JSON.stringify(Object.entries(ingredients).sort())}|${r.requiresTable}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ result: r.result.count, ingredients, table: r.requiresTable });
    }
    return out;
  }

  smeltingInputs(item: string): string[] {
    return SMELTING[normalizeName(item)] ?? [];
  }

  smeltsInto(input: string): string | null {
    const name = normalizeName(input);
    for (const [output, inputs] of Object.entries(SMELTING)) if (inputs.includes(name)) return output;
    return null;
  }

  /** The weakest tool that can harvest a block, e.g. "stone_pickaxe or better"; null if a hand works. */
  harvestRequirement(blockName: string): string | null {
    const block = this.bot.registry.blocksByName[normalizeName(blockName)];
    if (!block?.harvestTools) return null;
    const names = Object.keys(block.harvestTools).map((id) => this.bot.registry.items[Number(id)]?.name ?? "");
    const kind = names[0]?.split("_").slice(1).join("_") ?? "tool";
    const lowest = names.map((n) => TIERS.indexOf(n.split("_")[0]!)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
    return lowest === undefined ? names.join(" or ") : `${TIERS[lowest]}_${kind} or better`;
  }

  /** Blocks that drop an item when mined (excluding silk-touch-only drops). */
  blockSources(item: string): { block: string; chance: number; needs: string | null }[] {
    if (!this.blockSourceIndex) {
      this.blockSourceIndex = new Map();
      const loot = (this.bot.registry as unknown as { blockLoot?: Record<string, { drops: Drop[] }> }).blockLoot ?? {};
      for (const [block, entry] of Object.entries(loot)) {
        for (const drop of entry.drops) {
          if (drop.silkTouch) continue;
          const list = this.blockSourceIndex.get(drop.item) ?? [];
          list.push({ block, chance: drop.dropChance });
          this.blockSourceIndex.set(drop.item, list);
        }
      }
    }
    return (this.blockSourceIndex.get(normalizeName(item)) ?? []).map((s) => ({ ...s, needs: this.harvestRequirement(s.block) }));
  }

  /** Mobs that drop an item. */
  mobSources(item: string): { mob: string; chance: number }[] {
    if (!this.mobSourceIndex) {
      this.mobSourceIndex = new Map();
      const loot = (this.bot.registry as unknown as { entityLoot?: Record<string, { drops: Drop[] }> }).entityLoot ?? {};
      for (const [mob, entry] of Object.entries(loot)) {
        for (const drop of entry.drops) {
          const list = this.mobSourceIndex.get(drop.item) ?? [];
          list.push({ mob, chance: drop.dropChance });
          this.mobSourceIndex.set(drop.item, list);
        }
      }
    }
    return this.mobSourceIndex.get(normalizeName(item)) ?? [];
  }

  /** Every way to get an item, as readable text. */
  howToObtain(item: string): string {
    const name = itemByName(this.bot, item).name;
    const lines: string[] = [`How to get ${name}:`];
    const recipes = this.recipes(name);
    if (recipes.length) {
      const shown = recipes.slice(0, 3).map((r) => `${formatIngredients(r.ingredients)} -> ${r.result}${r.table ? " (crafting table)" : ""}`);
      lines.push(`- Craft: ${shown.join(" | ")}${recipes.length > 3 ? ` | +${recipes.length - 3} variants (e.g. other wood types)` : ""}`);
    }
    const smelt = this.smeltingInputs(name);
    if (smelt.length) lines.push(`- Smelt in a furnace (needs fuel): ${smelt.join(" or ")}`);
    const blocks = this.blockSources(name)
      .filter((s) => s.block !== name || !recipes.length)
      .slice(0, 6);
    if (blocks.length) {
      lines.push(`- Mine: ${blocks.map((b) => `${b.block}${b.needs ? ` (needs ${b.needs})` : ""}${b.chance < 1 ? ` (${Math.round(b.chance * 100)}% chance)` : ""}`).join(", ")}`);
    }
    const mobs = this.mobSources(name).slice(0, 6);
    if (mobs.length) lines.push(`- Mob drop: ${mobs.map((m) => `${m.mob}${m.chance < 1 ? ` (${Math.round(m.chance * 100)}%)` : ""}`).join(", ")}`);
    if (lines.length === 1) lines.push("- Not craftable, smeltable, minable, or dropped by mobs as far as the game data says (it may come from chests, trading, or fishing).");
    return lines.join("\n");
  }

  /** Facts about a block, item, or mob by name. */
  info(name: string): string {
    const key = normalizeName(name);
    const r = this.bot.registry;
    const lines: string[] = [];
    const block = r.blocksByName[key];
    if (block) {
      const tool = (block as unknown as { material?: string }).material?.match(/mineable\/(\w+)/)?.[1];
      lines.push(
        `Block ${key}: hardness ${block.hardness ?? "?"}${block.diggable ? "" : " (can't be mined)"}${tool ? `, fastest with ${tool}` : ""}, ${
          this.harvestRequirement(key) ? `drops only with ${this.harvestRequirement(key)}` : "drops with any tool or by hand"
        }.`,
      );
      const loot = (r as unknown as { blockLoot?: Record<string, { drops: Drop[] }> }).blockLoot?.[key];
      if (loot) lines.push(`Drops: ${loot.drops.filter((d) => !d.silkTouch).map((d) => `${d.item}${d.dropChance < 1 ? ` (${Math.round(d.dropChance * 100)}%)` : ""}`).join(", ") || "nothing"}.`);
    }
    const item = r.itemsByName[key];
    if (item) {
      const food = r.foodsByName[key];
      lines.push(
        `Item ${key}: stacks to ${item.stackSize}${item.maxDurability ? `, durability ${item.maxDurability}` : ""}${food ? `, food ${food.foodPoints} (saturation ${food.saturation})` : ""}.`,
      );
    }
    const mob = r.entitiesByName[key];
    if (mob) {
      const loot = (r as unknown as { entityLoot?: Record<string, { drops: Drop[] }> }).entityLoot?.[key];
      lines.push(`Mob ${key}: ${mob.type}${loot ? `, drops ${loot.drops.map((d) => d.item).join(", ")}` : ""}.`);
    }
    if (!lines.length) throw new ActionError("INVALID", `Nothing called "${name}" in the game data.`);
    return lines.join("\n");
  }

  /**
   * A bill of materials for `count` of an item given the current inventory: the
   * craft/smelt steps in order, and the raw materials still needed with how to get
   * them. Uses what's already in the inventory first.
   */
  materials(item: string, count: number): { steps: Step[]; raw: { item: string; count: number; how: string }[]; used: Record<string, number> } {
    const target = itemByName(this.bot, item).name;
    const have = inventoryCounts(this.bot);
    const used: Record<string, number> = {};
    const steps: Step[] = [];
    const raw = new Map<string, number>();
    this.expand(target, count, have, used, steps, raw, new Set(), 0);
    return {
      steps: mergeSteps(steps),
      raw: [...raw].map(([name, n]) => ({ item: name, count: n, how: this.rawHint(name) })),
      used,
    };
  }

  private expand(
    item: string,
    qty: number,
    have: Map<string, number>,
    used: Record<string, number>,
    steps: Step[],
    raw: Map<string, number>,
    visiting: Set<string>,
    depth: number,
  ) {
    const available = have.get(item) ?? 0;
    const take = Math.min(available, qty);
    if (take > 0) {
      have.set(item, available - take);
      used[item] = (used[item] ?? 0) + take;
      qty -= take;
    }
    if (qty <= 0) return;
    if (depth > 8 || visiting.has(item)) {
      raw.set(item, (raw.get(item) ?? 0) + qty);
      return;
    }
    visiting.add(item);
    const choice = this.chooseRecipe(item, have, visiting);
    // raw_iron "from" raw_iron_block is technically a recipe, but you mine iron ore.
    const minable = this.blockSources(item).some((s) => s.chance >= 0.1) || this.mobSources(item).length > 0;
    const recipe = choice && !(choice.score < 0 && minable) ? choice.recipe : null;
    const smeltFrom = this.smeltingInputs(item);
    const craftReady = recipe && Object.keys(recipe.ingredients).every((i) => (have.get(i) ?? 0) > 0);
    if (smeltFrom.length && !craftReady) {
      const input = smeltFrom.find((i) => (have.get(i) ?? 0) > 0) ?? smeltFrom[0]!;
      this.expand(input, qty, have, used, steps, raw, visiting, depth + 1);
      steps.push({ action: "smelt", item, count: qty, from: input });
    } else if (recipe) {
      const crafts = Math.ceil(qty / recipe.result);
      for (const [ingredient, n] of Object.entries(recipe.ingredients)) this.expand(ingredient, n * crafts, have, used, steps, raw, visiting, depth + 1);
      steps.push({ action: "craft", item, count: crafts * recipe.result, table: recipe.table });
      const extra = crafts * recipe.result - qty;
      if (extra > 0) have.set(item, (have.get(item) ?? 0) + extra);
    } else {
      raw.set(item, (raw.get(item) ?? 0) + qty);
    }
    visiting.delete(item);
  }

  /**
   * Picks the recipe that best uses what's on hand, avoiding cycles and un-compressing
   * storage blocks, and breaking ties toward common materials (cobblestone over
   * cobbled_deepslate, oak over cherry).
   */
  private chooseRecipe(item: string, have: Map<string, number>, visiting: Set<string>): { recipe: Recipe; score: number } | null {
    let best: Recipe | null = null;
    let bestScore = -Infinity;
    for (const recipe of this.recipes(item)) {
      const ingredients = Object.keys(recipe.ingredients);
      if (ingredients.some((i) => visiting.has(i))) continue;
      let score = 0;
      for (const ingredient of ingredients) {
        if ((have.get(ingredient) ?? 0) > 0) score += 1;
        else if (this.recipes(ingredient).some((r) => Object.keys(r.ingredients).every((i) => (have.get(i) ?? 0) > 0))) score += 0.5;
        // Getting ingots back out of an iron_block you don't have is never the plan.
        if (/_block$/.test(ingredient) && !(have.get(ingredient) ?? 0)) score -= 2;
      }
      score /= Math.max(ingredients.length, 1);
      for (const ingredient of ingredients) {
        if (COMMON.test(ingredient)) score += 0.05;
        if (UNCOMMON.test(ingredient)) score -= 0.05;
      }
      if (score > bestScore) {
        best = recipe;
        bestScore = score;
      }
    }
    return best ? { recipe: best, score: bestScore } : null;
  }

  private rawHint(item: string): string {
    const blocks = this.blockSources(item).filter((s) => s.chance >= 0.1);
    const direct = blocks.find((b) => b.block === item);
    if (direct) return `mine ${direct.block}${direct.needs ? ` (needs ${direct.needs})` : ""}`;
    if (blocks.length) return `mine ${blocks.slice(0, 2).map((b) => `${b.block}${b.needs ? ` (needs ${b.needs})` : ""}`).join(" or ")}`;
    const mobs = this.mobSources(item);
    if (mobs.length) return `kill ${mobs.slice(0, 3).map((m) => m.mob).join(" or ")}`;
    return "find it (not craftable or minable)";
  }
}

function formatIngredients(ingredients: Record<string, number>): string {
  return Object.entries(ingredients)
    .map(([name, n]) => `${n} ${name}`)
    .join(" + ");
}

/** Merges repeated steps for the same item (e.g. planks needed by two ingredients). */
function mergeSteps(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const step of steps) {
    const existing = out.find((s) => s.action === step.action && s.item === step.item && s.from === step.from);
    if (existing) existing.count += step.count;
    else out.push({ ...step });
  }
  return out;
}

export function formatMaterials(item: string, count: number, plan: ReturnType<Knowledge["materials"]>): string {
  const lines = [`Plan for ${count} ${item}:`];
  const used = Object.entries(plan.used);
  if (used.length) lines.push(`Uses from inventory: ${used.map(([n, c]) => `${c} ${n}`).join(", ")}`);
  if (plan.raw.length) lines.push(`Still need to gather: ${plan.raw.map((r) => `${r.count} ${r.item} (${r.how})`).join("; ")}`);
  else lines.push("Everything needed is in the inventory.");
  if (plan.steps.length) {
    lines.push("Steps in order:");
    plan.steps.forEach((s, i) =>
      lines.push(`${i + 1}. ${s.action === "craft" ? `craft ${s.count} ${s.item}${s.table ? " (crafting table)" : ""}` : `smelt ${s.count} ${s.from} into ${s.item} (furnace + fuel)`}`),
    );
  }
  return lines.join("\n");
}
