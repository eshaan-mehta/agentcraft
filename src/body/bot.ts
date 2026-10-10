import mineflayer, { type Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { config } from "../config.js";

const { pathfinder, Movements } = pathfinderPkg;

// Blocks that are almost always player-built (by the bot itself, here). The
// pathfinder won't dig through them to reach a destination, so the bot doesn't
// tunnel through its own house or storage.
const PLAYER_BUILT =
  /_planks$|_door$|_trapdoor$|_bed$|glass|_wool$|_carpet$|_fence|_stairs$|_slab$|_sign$|torch|lantern|^(chest|trapped_chest|barrel|crafting_table|furnace|blast_furnace|smoker|bookshelf|ladder|bricks|stone_bricks)$/;

// Blocks the pathfinder may place to bridge gaps or tower up.
const SCAFFOLDING = ["dirt", "cobblestone", "cobbled_deepslate", "netherrack", "andesite", "diorite", "granite", "tuff"];

export interface MovementProfiles {
  /** Digs through and builds over obstacles as needed. */
  normal: InstanceType<typeof Movements>;
  /** Walks only: never breaks or places blocks on the way. */
  careful: InstanceType<typeof Movements>;
  /** Running from mobs: walks only, no jumps across gaps, no drops over 2 blocks. */
  flee: InstanceType<typeof Movements>;
}

export async function connect(): Promise<{ bot: Bot; movements: MovementProfiles }> {
  const bot = mineflayer.createBot({
    host: config.mc.host,
    port: config.mc.port,
    username: config.mc.username,
    version: config.mc.version,
    auth: config.mc.auth,
  });
  bot.loadPlugin(pathfinder);

  await new Promise<void>((resolve, reject) => {
    const fail = (reason: unknown) => reject(new Error(`Could not join the server: ${String(reason)}`));
    bot.once("spawn", () => {
      bot.off("error", fail);
      bot.off("kicked", fail);
      bot.off("end", fail);
      resolve();
    });
    bot.once("error", fail);
    bot.once("kicked", fail);
    bot.once("end", fail);
  });

  const normal = new Movements(bot);
  for (const block of Object.values(bot.registry.blocksByName)) {
    if (PLAYER_BUILT.test(block.name)) normal.blocksCantBreak.add(block.id);
  }
  normal.scafoldingBlocks = SCAFFOLDING.map((name) => bot.registry.itemsByName[name]?.id).filter((id): id is number => id !== undefined);

  const careful = new Movements(bot);
  careful.canDig = false;
  careful.allow1by1towers = false;
  careful.scafoldingBlocks = [];

  // Fleeing into a ravine, a lava cave, or deep water kills more often than the mob.
  const flee = new Movements(bot);
  flee.canDig = false;
  flee.allow1by1towers = false;
  flee.scafoldingBlocks = [];
  flee.allowParkour = false;
  flee.maxDropDown = 2;

  for (const profile of [normal, careful, flee]) {
    // By default a path may drop any distance into water, which is how bots end up at
    // the bottom of flooded caves. Keep to the normal drop limit, and prefer dry routes.
    profile.infiniteLiquidDropdownDistance = false;
    (profile as typeof profile & { liquidCost: number }).liquidCost = 4; // not in the type definitions
  }

  bot.pathfinder.setMovements(normal);
  // Plan in 40ms slices per tick, for up to 10s per plan. The navigator replans from
  // wherever a partial route ends, so a long trip doesn't need one huge plan.
  bot.pathfinder.thinkTimeout = 10_000;
  bot.pathfinder.tickTimeout = 40;
  return { bot, movements: { normal, careful, flee } };
}
