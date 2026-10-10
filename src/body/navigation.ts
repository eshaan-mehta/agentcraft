import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { setTimeout as sleep } from "node:timers/promises";
import { Vec3 } from "vec3";
import { ActionError, abortError } from "../errors.js";
import { formatPos } from "../world/perception.js";
import type { MovementProfiles } from "./bot.js";

const { goals } = pathfinderPkg;
type Entity = Bot["entity"];
type Goal = pathfinderPkg.goals.Goal;
type Move = { x: number; y: number; z: number };

export interface Point {
  x: number;
  y: number;
  z: number;
}

export type Target =
  /** Get within `range` blocks of a position (default 1). */
  | { x: number; y: number; z: number; range?: number }
  /** Get to an x/z column at whatever height is reachable. */
  | { x: number; z: number; range?: number }
  /** Stand somewhere this block is within arm's reach (to dig, place against, or use it). */
  | { reach: Point }
  /** Get within `range` of an entity, following it if it moves (default 2). */
  | { entity: Entity; range?: number }
  /** Get at least `distance` blocks away from a point or entity. */
  | { awayFrom: Point | Entity; distance: number };

export interface NavOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Walk only: never dig through or build over anything on the way. */
  careful?: boolean;
}

export interface Arrival {
  position: string;
  seconds: number;
  replans: number;
}

/** Arm's reach for digging and placing, measured from the eyes to the block's center. */
export const REACH = 4.3;
const EYE_HEIGHT = 1.62;

/** Satisfied anywhere the target block is within reach (and the bot isn't standing in it). */
class GoalReach extends goals.Goal {
  constructor(private readonly block: Vec3) {
    super();
  }
  heuristic(node: Move) {
    const dx = node.x + 0.5 - (this.block.x + 0.5);
    const dy = node.y + EYE_HEIGHT - (this.block.y + 0.5);
    const dz = node.z + 0.5 - (this.block.z + 0.5);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  isEnd(node: Move) {
    const inside = node.x === this.block.x && node.z === this.block.z && (node.y === this.block.y || node.y + 1 === this.block.y);
    return !inside && this.heuristic(node) <= REACH;
  }
}

function isEntity(value: Point | Entity): value is Entity {
  return "position" in value;
}

/**
 * Moves the bot with the pathfinder, but owns the loop instead of trusting goto():
 * when a plan times out, the bot follows the best partial route and replans from
 * wherever it ends up; it only gives up on a real "no route" or when it stops making
 * progress. Every failure says why, so the agent can choose another approach.
 */
export class Navigator {
  constructor(
    private readonly bot: Bot,
    private readonly movements: MovementProfiles,
  ) {}

  async go(target: Target, options: NavOptions = {}): Promise<Arrival> {
    const bot = this.bot;
    const { goal, dynamic, remaining, label } = this.goalFor(target);
    const started = Date.now();
    if (this.arrived(goal, dynamic)) return { position: formatPos(bot.entity.position), seconds: 0, replans: 0 };

    const timeoutMs = options.timeoutMs ?? Math.min(30_000 + remaining() * 1_500, 600_000);
    let best = remaining();
    let lastProgress = Date.now();
    let status = "";
    let planned = false;
    let reached = false;
    let noRoute = 0;
    let replans = 0;
    const onUpdate = (results: { status: string; path: unknown[] }) => {
      status = results.status;
      planned = true;
      if (results.status === "noPath" && results.path.length === 0) noRoute++;
    };
    const onReached = () => (reached = true);
    const plan = () => {
      planned = false;
      bot.pathfinder.setGoal(goal, dynamic);
    };

    bot.pathfinder.setMovements(options.careful ? this.movements.careful : this.movements.normal);
    bot.on("path_update", onUpdate);
    bot.on("goal_reached", onReached);
    plan();
    try {
      while (true) {
        if (options.signal?.aborted) throw abortError(options.signal);
        const pos = bot.entity.position;
        if (reached || this.arrived(goal, dynamic)) {
          return { position: formatPos(pos), seconds: Math.round((Date.now() - started) / 1000), replans };
        }
        const left = remaining();
        // Digging or bridging counts as progress even when the distance doesn't change.
        if (left < best - 1 || bot.pathfinder.isMining() || bot.pathfinder.isBuilding()) {
          best = Math.min(best, left);
          lastProgress = Date.now();
        }
        if (planned && !bot.pathfinder.isMoving()) {
          // The route ran out short of the goal: a partial plan, or no route at all.
          if (noRoute >= 2) {
            throw new ActionError("UNREACHABLE", `No route to ${label} from ${formatPos(pos)}${options.careful ? " without digging or building" : ""}.`);
          }
          if (++replans > 15) {
            throw new ActionError("STUCK", `Kept failing to make headway toward ${label}; stopped at ${formatPos(pos)}, ${left.toFixed(0)} blocks away.`);
          }
          plan();
        }
        if (Date.now() - lastProgress > 15_000) {
          throw new ActionError(
            "STUCK",
            `No progress toward ${label} for 15s (last plan: ${status || "none"}); stuck at ${formatPos(pos)}, ${left.toFixed(0)} blocks away.`,
          );
        }
        if (Date.now() - started > timeoutMs) {
          throw new ActionError("TIMEOUT", `Ran out of time (${Math.round(timeoutMs / 1000)}s) heading to ${label}; at ${formatPos(pos)}, ${left.toFixed(0)} blocks away.`);
        }
        await sleep(250);
      }
    } finally {
      bot.off("path_update", onUpdate);
      bot.off("goal_reached", onReached);
      bot.pathfinder.setGoal(null);
      if (options.careful) bot.pathfinder.setMovements(this.movements.normal);
    }
  }

  /** Plans a route without moving, to check whether and how far a target is reachable. */
  async check(target: Target, timeoutMs = 4_000): Promise<{ reachable: boolean; status: string; steps: number }> {
    const bot = this.bot;
    const { goal } = this.goalFor(target);
    const generator = bot.pathfinder.getPathFromTo(this.movements.normal, bot.entity.position, goal, { timeout: timeoutMs });
    let result = generator.next().value?.result;
    // Planning runs in slices; yield between them so the bot keeps ticking.
    while (result?.status === "partial") {
      await sleep(0);
      result = generator.next().value?.result;
    }
    const status = result?.status ?? "noPath";
    return { reachable: status === "success", status, steps: result?.path.length ?? 0 };
  }

  private arrived(goal: Goal, dynamic: boolean) {
    const pos = this.bot.entity.position;
    // Dynamic goals (entities) measure from the exact position; static ones from the block.
    // (isEnd only reads x/y/z, whatever its declared parameter type says.)
    const node = (dynamic ? pos : pos.floored()) as unknown as Parameters<Goal["isEnd"]>[0];
    return goal.isEnd(node);
  }

  private goalFor(target: Target): { goal: Goal; dynamic: boolean; remaining: () => number; label: string } {
    const here = () => this.bot.entity.position;
    if ("reach" in target) {
      const block = new Vec3(Math.floor(target.reach.x), Math.floor(target.reach.y), Math.floor(target.reach.z));
      const center = block.offset(0.5, 0.5, 0.5);
      return {
        goal: new GoalReach(block),
        dynamic: false,
        remaining: () => Math.max(0, here().offset(0, EYE_HEIGHT, 0).distanceTo(center) - REACH),
        label: `reach of ${formatPos(block)}`,
      };
    }
    if ("entity" in target) {
      const range = target.range ?? 2;
      const entity = target.entity;
      return {
        goal: new goals.GoalFollow(entity, range),
        dynamic: true,
        remaining: () => Math.max(0, here().distanceTo(entity.position) - range),
        label: `${entity.name ?? "entity"} at ${formatPos(entity.position)}`,
      };
    }
    if ("awayFrom" in target) {
      const from = target.awayFrom;
      const where = () => (isEntity(from) ? from.position : new Vec3(from.x, from.y, from.z));
      const near = isEntity(from)
        ? new goals.GoalFollow(from, target.distance)
        : new goals.GoalNear(from.x, from.y, from.z, target.distance);
      return {
        goal: new goals.GoalInvert(near),
        dynamic: isEntity(from),
        remaining: () => Math.max(0, target.distance - here().distanceTo(where())),
        label: `${target.distance} blocks away from ${isEntity(from) ? from.name : formatPos(where())}`,
      };
    }
    const range = target.range ?? 1;
    if ("y" in target && target.y !== undefined) {
      const point = new Vec3(target.x, target.y, target.z);
      return {
        goal: new goals.GoalNear(target.x, target.y, target.z, range),
        dynamic: false,
        remaining: () => Math.max(0, here().distanceTo(point) - range),
        label: formatPos(point),
      };
    }
    return {
      goal: new goals.GoalNearXZ(target.x, target.z, range),
      dynamic: false,
      remaining: () => Math.max(0, Math.hypot(here().x - target.x, here().z - target.z) - range),
      label: `x ${Math.floor(target.x)}, z ${Math.floor(target.z)}`,
    };
  }
}
