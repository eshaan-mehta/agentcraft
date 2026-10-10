// Keeps the bot alive no matter what Claude is doing. Reflexes (fight, flee, eat,
// wear armor, stay afloat, come up for air) run in code every half second and take
// the body from whatever task holds it. Needs that take planning (night is coming,
// no food, just died, idle without basics) are raised with Claude as [survival] messages.
import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { setTimeout as sleep } from "node:timers/promises";
import { Vec3 } from "vec3";
import type { Body } from "../body/body.js";
import type { Motor } from "../body/motor.js";
import { config } from "../config.js";
import { Died, Interrupted, abortError, errorText } from "../errors.js";
import { log } from "../log.js";
import { bestWeapon, distanceTo, enclosure, equipment, foods, formatPos, isHostile, isSheltered, readiness, shelterBlocks } from "../world/perception.js";

const { goals } = pathfinderPkg;
type Entity = Bot["entity"];
type Block = NonNullable<ReturnType<Bot["blockAt"]>>;
type Outcome = { kind: string; text: string } | null;

/** What the survival layer needs from the agent. */
export interface SurvivalHost {
  /** How long the agent has had nothing to do (0 while it's working on something). */
  idleMs(): number;
  /** Raises a survival need with Claude, starting a turn if it's idle. */
  alert(text: string): void;
  /** Tells Claude what a reflex did, along with its next message. */
  report(text: string): void;
}

const TICK_MS = 500;
const NEEDS_CHECK_MS = 5_000;
const THREAT_RANGE = 10; // hostile mobs closer than this get dealt with
const ATTACKER_RANGE = 24; // how far to go after something that just hit us (skeletons shoot from afar)
const RUN_FROM = new Set(["creeper", "warden"]);
const RUN_FROM_RANGE = 12; // creepers: start running well before the 3-block fuse range
const LOW_HEALTH = 6; // 3 hearts: stop fighting and run
const HURT = 12; // unarmed, stop trading blows; caught, seal in (digging in takes ~3s of being hit)
const EAT_AT_FOOD = 14;
const STARVING = 6; // at or below this, eat even if it interrupts a task
const LOW_AIR = 12; // of 20: about 9 seconds left before drowning starts
const WATERY = new Set(["water", "bubble_column", "kelp", "kelp_plant", "seagrass", "tall_seagrass"]);
// Up first, so that among equally short swims the route goes straight up.
const SWIM_STEPS = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]].map(([x, y, z]) => new Vec3(x!, y!, z!));

const ARMOR_TIERS = ["leather", "golden", "copper", "chainmail", "iron", "diamond", "netherite"];
const ARMOR = [
  { suffix: "_helmet", slot: "head" },
  { suffix: "_chestplate", slot: "torso" },
  { suffix: "_leggings", slot: "legs" },
  { suffix: "_boots", slot: "feet" },
] as const;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Air from 0 to 20. (Mineflayer's reading can briefly be out of range on newer versions.) */
function air(bot: Bot): number {
  return Math.max(0, Math.min(20, bot.oxygenLevel ?? 20));
}

function armorRank(name: string | null): number {
  if (!name) return -1;
  if (name === "turtle_helmet") return ARMOR_TIERS.indexOf("iron");
  return ARMOR_TIERS.findIndex((tier) => name.startsWith(`${tier}_`));
}

export class Survival {
  private host!: SurvivalHost;
  private busy = false;
  private attacker: { entity: Entity; at: number } | null = null;
  private lastFailedEscape = 0;
  private lastEatAttempt = 0;
  private lastArmorCheck = 0;
  private lastNeedsCheck = 0;
  private ignored = new Map<number, number>(); // entity id -> ignore until (couldn't reach it)
  private swimming = false;
  private shelterCache = { at: 0, value: false };
  private lastAlert = new Map<string, number>();
  private lastReport = new Map<string, number>();
  private eveningAlertDay = -1;
  private shelteredTonight = false;
  private nightSeen = false;
  private deaths: { at: number; where: string }[] = [];
  private deathCount = 0;
  private deathAlertTimer: NodeJS.Timeout | null = null;
  private lastDeathAlert = 0;
  private aboutMe: { text: string; at: number }[] = [];

  constructor(
    private readonly bot: Bot,
    private readonly body: Body,
    private readonly motor: Motor,
    /** Seals the bot in where it stands (dig in, or wall in with a roof). */
    private readonly shelter: (signal: AbortSignal) => Promise<string>,
  ) {}

  start(host: SurvivalHost) {
    this.host = host;
    const bot = this.bot;
    // Damage events name the mob responsible (the skeleton, not its arrow). Falls,
    // starvation, and drowning have no source and don't count as being attacked.
    bot.on("entityHurt", (entity, source) => {
      if (entity === bot.entity && source && source !== bot.entity) this.attacker = { entity: source, at: Date.now() };
    });
    bot.on("death", () => this.onDeath());
    // Death messages ("Claude was slain by Zombie") arrive as server chat.
    bot.on("messagestr", (text) => {
      if (!text.startsWith(`${bot.username} `)) return;
      this.aboutMe.push({ text: text.slice(bot.username.length + 1), at: Date.now() });
      if (this.aboutMe.length > 20) this.aboutMe.shift();
    });
    setInterval(() => this.tick(), TICK_MS);
  }

  private tick() {
    const bot = this.bot;
    if (this.busy || !bot.entity || bot.health <= 0) return;
    this.stayAfloat();
    if (bot.oxygenLevel <= LOW_AIR && this.submerged()) return this.takeOver("air", (signal) => this.surface(signal));

    const threats = this.threats();
    if (threats.length) {
      const flee = this.fleeReason(threats);
      // If a task is already fighting, let it, unless it's time to run.
      if (!flee && this.body.owner?.startsWith("task:") && /attack|fight|hunt/.test(this.body.owner)) return;
      return this.takeOver(flee ? "flee" : "fight", (signal) => (flee ? this.flee(flee.from, flee.reason, signal) : this.fightBack(threats[0]!, signal)));
    }

    const food = this.foodToEat();
    if (food) {
      this.lastEatAttempt = Date.now();
      return this.takeOver("eat", async () => ({ kind: "eat", text: await this.motor.eat(food) }));
    }

    const now = Date.now();
    if (now - this.lastArmorCheck > 10_000 && !this.body.owner) {
      this.lastArmorCheck = now;
      const upgrades = this.armorUpgrades();
      if (upgrades.length) {
        return this.takeOver("armor", async () => {
          for (const { item, slot } of upgrades) await this.motor.equip(item, slot);
          return { kind: "armor", text: `Put on ${upgrades.map((u) => u.item).join(", ")}.` };
        });
      }
    }

    if (now - this.lastNeedsCheck > NEEDS_CHECK_MS) {
      this.lastNeedsCheck = now;
      if (config.autonomy) this.checkNeeds();
    }
  }

  /** Runs a reflex with the body, taking it from (and interrupting) any task that holds it. */
  private takeOver(name: string, run: (signal: AbortSignal) => Promise<Outcome>) {
    this.busy = true;
    const deaths = this.deathCount;
    void (async () => {
      try {
        const outcome = await this.body.with(`reflex:${name}`, "reflex", undefined, run);
        // If it died partway, the outcome ("ran", "killed it") is wrong; the death alert covers it.
        if (outcome && this.deathCount === deaths) {
          log.event(`Reflex: ${outcome.text}`);
          // A run of the same thing (several fights, several bites) is reported once.
          if (Date.now() - (this.lastReport.get(outcome.kind) ?? 0) > 15_000) this.host.report(outcome.text);
          this.lastReport.set(outcome.kind, Date.now());
        }
      } catch (err) {
        if (!(err instanceof Died)) log.error(`Survival reflex failed: ${errorText(err)}`, err);
      } finally {
        this.busy = false;
      }
    })();
  }

  private threats(): Entity[] {
    const bot = this.bot;
    if (bot.isSleeping) return []; // taking damage wakes you up
    const now = Date.now();
    const recent = this.attacker && now - this.attacker.at < 5_000 ? this.attacker.entity : null;
    const me = bot.entity.position;
    const threats = Object.values(bot.entities)
      .filter((e) => {
        if (e === bot.entity || !e.isValid) return false;
        const d = e.position.distanceTo(me);
        // Whatever just hit us, even if it's normally peaceful (a provoked enderman, a wolf),
        // and even if we'd given up on reaching it: it can clearly reach us.
        if (e === recent) return e.type !== "player" && d <= ATTACKER_RANGE;
        if ((this.ignored.get(e.id) ?? 0) > now) return false;
        if (RUN_FROM.has(e.name ?? "")) return d <= RUN_FROM_RANGE;
        if (!isHostile(e)) return false;
        return d <= THREAT_RANGE && Math.abs(e.position.y - me.y) <= 4; // not one in a cave below
      })
      .sort((a, b) => (a === recent ? -1 : b === recent ? 1 : a.position.distanceTo(me) - b.position.distanceTo(me)));
    // Walled in, nothing outside can reach us; never break out to chase or run. Only a
    // mob shut in with us (spawned in a dark room, sealed into a cave) still counts.
    // Checked fresh, not cached: the bot may have just sealed itself in.
    const space = threats.length ? enclosure(bot) : null;
    return space ? threats.filter((e) => space.has(e.position.floored().toString())) : threats;
  }

  private fleeReason(threats: Entity[]): { from: Entity; reason: string } | null {
    const bot = this.bot;
    const health = Math.round(bot.health);
    const runFrom = threats.find((e) => RUN_FROM.has(e.name ?? ""));
    if (runFrom) return { from: runFrom, reason: `a ${runFrom.name} got within ${distanceTo(bot, runFrom.position).toFixed(0)}m` };
    const nearest = threats[0]!;
    // Badly hurt: never stand and fight (if it keeps up, flee seals the bot in instead).
    if (health <= LOW_HEALTH) return { from: nearest, reason: `health was down to ${health}/20` };
    // Cornered recently: running didn't work, so fight instead.
    if (Date.now() - this.lastFailedEscape < 15_000) return null;
    // Fists do 1 damage: a bare-handed fight with a zombie costs most of your health.
    if (!bestWeapon(bot)) return { from: nearest, reason: "you have no weapon" };
    const crowd = threats.filter((e) => distanceTo(bot, e.position) <= 8).length;
    if (crowd >= 3 && health <= 14) return { from: nearest, reason: `${crowd} hostile mobs closed in at health ${health}/20` };
    return null;
  }

  private async fightBack(target: Entity, signal: AbortSignal): Promise<Outcome> {
    const bot = this.bot;
    log.event(`Reflex: fighting a ${target.name} ${distanceTo(bot, target.position).toFixed(0)}m away (health ${Math.round(bot.health)}/20)`);
    const result = await this.motor.fight(target, {
      signal,
      timeoutMs: 20_000,
      // Bare-handed, a fight is a slow trade of hits: quit while there's health left to escape on.
      stopAtHealth: bestWeapon(bot) ? LOW_HEALTH : HURT,
      // A creeper walking up mid-fight is the bigger danger.
      stopIf: () => target.name !== "creeper" && this.creeperWithin(5) !== undefined,
    });
    const health = Math.round(bot.health);
    if (result === "killed") return { kind: "fight", text: `Killed a ${target.name} that came at you. Health ${health}/20.` };
    if (result === "stopped") return this.flee(this.creeperWithin(8) ?? target, `a creeper came close while fighting a ${target.name}`, signal);
    if (result === "low_health") {
      const why = `health dropped to ${health}/20 fighting a ${target.name}`;
      // It already outran us once: running again just means dying tired.
      return Date.now() - this.lastFailedEscape < 15_000 ? this.hunker(why, signal) : this.flee(target, why, signal);
    }
    // Couldn't reach it (up a ledge, down a drop, across water): leave it alone for a while.
    this.ignored.set(target.id, Date.now() + 30_000);
    const why = result === "lost" ? "it got away" : "couldn't reach it";
    return { kind: "fight", text: `Went after a ${target.name} but ${why}; it's at ${formatPos(target.position)}. Health ${health}/20.` };
  }

  private async flee(from: Entity, reason: string, signal: AbortSignal): Promise<Outcome> {
    const bot = this.bot;
    log.event(`Reflex: running from a ${from.name} because ${reason}`);
    const started = Date.now();
    let goalSetAt = 0;
    const deadline = started + 12_000;
    // Walk only, no big drops: fleeing into a ravine or a lava cave is worse than the mob.
    this.motor.nav.use("flee");
    try {
      while (Date.now() < deadline && from.isValid && distanceTo(bot, from.position) < 16) {
        if (signal.aborted) throw abortError(signal);
        // It's keeping pace and still biting (a spider outruns a sprinting player), so
        // running just means being chewed on from behind.
        const bitten = this.attacker?.entity.id === from.id && this.attacker.at > started + 1_500;
        if (bitten && !RUN_FROM.has(from.name ?? "") && distanceTo(bot, from.position) < 4) {
          bot.pathfinder.setGoal(null);
          this.lastFailedEscape = Date.now();
          const health = Math.round(bot.health);
          // Hurt, or it's an enderman (they teleport after you): fighting on is how bots die.
          if (health <= HURT || from.name === "enderman") {
            return this.hunker(`Couldn't get away from a ${from.name} (ran because ${reason}; health ${health}/20)`, signal);
          }
          // Otherwise turn and fight, even bare-handed.
          log.event(`Reflex: the ${from.name} kept up, turning to fight it`);
          const fought = await this.fightBack(from, signal);
          return fought && { ...fought, text: `Couldn't outrun a ${from.name} (ran because ${reason}), so turned and fought it. ${fought.text}` };
        }
        // Run for a fixed spot 20 blocks directly away, re-aimed every 2s. (A goal that
        // follows the mob replans every tick, and the stuttering bot gets caught.) Also
        // re-set it if a just-cancelled action cleared it.
        if (!bot.pathfinder.goal || Date.now() - goalSetAt > 2_000) {
          const away = bot.entity.position.minus(from.position);
          away.y = 0;
          const dir = away.norm() > 0.1 ? away.normalize() : new Vec3(1, 0, 0);
          const spot = bot.entity.position.plus(dir.scaled(20));
          bot.pathfinder.setGoal(new goals.GoalXZ(Math.floor(spot.x), Math.floor(spot.z)));
          goalSetAt = Date.now();
        }
        await sleep(250);
      }
    } finally {
      bot.pathfinder.setGoal(null);
      this.motor.nav.use("normal");
    }
    const escaped = !from.isValid || distanceTo(bot, from.position) >= 16;
    if (!escaped) this.lastFailedEscape = Date.now();
    const health = Math.round(bot.health);
    return {
      kind: "flee",
      text: `${escaped ? "Ran" : "Tried to run"} from a ${from.name} because ${reason}. Now at ${formatPos(bot.entity.position)}, health ${health}/20.`,
    };
  }

  /** The last resort when it can't win or get away: seal itself in where it stands. */
  private async hunker(why: string, signal: AbortSignal): Promise<Outcome> {
    log.event(`Reflex: ${why}; sealing in`);
    try {
      const result = await this.shelter(signal);
      return { kind: "shelter", text: `${capitalize(why)}, so sealed yourself in. ${result} Heal before going back out: eat (health only regenerates at 18+ food).` };
    } catch (err) {
      if (err instanceof Interrupted) throw err;
      const target = this.threats()[0];
      if (!target) return { kind: "shelter", text: `${capitalize(why)}, and couldn't seal in: ${errorText(err)}` };
      // Nowhere to hide: fighting back beats being chewed on.
      log.event(`Reflex: couldn't seal in (${errorText(err)}); fighting the ${target.name}`);
      const result = await this.motor.fight(target, { signal, timeoutMs: 20_000 });
      return { kind: "fight", text: `${capitalize(why)}, couldn't seal in (${errorText(err)}), so fought the ${target.name} (${result}). Health ${Math.round(this.bot.health)}/20.` };
    }
  }

  private creeperWithin(range: number): Entity | undefined {
    return Object.values(this.bot.entities).find((e) => e.name === "creeper" && e.isValid && distanceTo(this.bot, e.position) <= range);
  }

  private foodToEat(): string | null {
    const bot = this.bot;
    if (Date.now() - this.lastEatAttempt < 3_000 || bot.food >= 20) return null;
    const hungry = bot.food <= EAT_AT_FOOD || (bot.health <= 14 && bot.food < 18); // health only regenerates at 18+ food
    if (!hungry) return null;
    // Don't interrupt a task for a snack: wait for a gap, unless starving or hurt
    // (hurt and below 18 food, health won't come back until it eats).
    if (this.body.owner && bot.food > STARVING && !(bot.health <= 10 && bot.food < 18)) return null;
    return foods(bot)[0]?.name ?? null;
  }

  private armorUpgrades() {
    const bot = this.bot;
    const worn = equipment(bot);
    const upgrades: { item: string; slot: (typeof ARMOR)[number]["slot"] }[] = [];
    for (const { suffix, slot } of ARMOR) {
      const best = bot.inventory
        .items()
        .filter((i) => i.name.endsWith(suffix) && armorRank(i.name) >= 0)
        .sort((a, b) => armorRank(b.name) - armorRank(a.name))[0];
      if (best && armorRank(best.name) > armorRank(worn[slot] ?? null)) upgrades.push({ item: best.name, slot });
    }
    return upgrades;
  }

  /** Holds the jump key while underwater and idle, so the bot doesn't sink and drown. */
  private stayAfloat() {
    const bot = this.bot;
    const swim = this.headUnderwater() && !bot.pathfinder.isMoving();
    if (swim !== this.swimming) {
      bot.setControlState("jump", swim);
      this.swimming = swim;
    }
  }

  private watery(block: Block | null): boolean {
    return Boolean(block && (WATERY.has(block.name) || block.getProperties().waterlogged === true));
  }

  private headUnderwater(): boolean {
    return this.watery(this.bot.blockAt(this.bot.entity.position.offset(0, 1.62, 0)));
  }

  /**
   * Whether the server counts the bot as underwater. Sprinting through water puts it in
   * the swimming pose, with its eyes at body height, so check there too while air drains.
   */
  private submerged(): boolean {
    const bot = this.bot;
    return this.headUnderwater() || (bot.oxygenLevel < 20 && this.watery(bot.blockAt(bot.entity.position.offset(0, 0.4, 0))));
  }

  /** Swims to the nearest air it can reach through the water, before drowning starts. */
  private async surface(signal: AbortSignal): Promise<Outcome> {
    const bot = this.bot;
    log.event(`Reflex: running out of air underwater (air ${air(bot)}/20), swimming up`);
    const deadline = Date.now() + 15_000;
    try {
      while (this.headUnderwater() && Date.now() < deadline) {
        if (signal.aborted) throw abortError(signal);
        const head = bot.entity.position.offset(0, 1.62, 0);
        // Steer for the first waypoint more than a block away: up when it's level or
        // above, forward when it's off to the side.
        const next = this.swimRoute()?.find((p) => p.offset(0.5, 0.5, 0.5).distanceTo(head) > 1.2);
        bot.setControlState("jump", !next || next.y + 0.5 >= head.y - 0.3);
        if (next) {
          const flat = Math.hypot(next.x + 0.5 - bot.entity.position.x, next.z + 0.5 - bot.entity.position.z);
          await bot.lookAt(next.offset(0.5, 0.5, 0.5), true);
          bot.setControlState("forward", flat > 0.4);
        }
        await sleep(200);
      }
    } finally {
      bot.clearControlStates();
      this.swimming = false;
    }
    const where = formatPos(bot.entity.position);
    return this.headUnderwater()
      ? { kind: "air", text: `Ran low on air underwater at ${where} and couldn't find a way up to air. Air ${air(bot)}/20; at 0 you start drowning.` }
      : { kind: "air", text: `Ran low on air underwater, so swam to air at ${where}. Keep an eye on air when working underwater.` };
  }

  /**
   * The shortest swim from head height to air, through water only (so never toward
   * air behind a wall): the head positions along the way, ending in the air block.
   */
  private swimRoute(): Vec3[] | null {
    const bot = this.bot;
    const start = bot.entity.position.offset(0, 1.62, 0).floored();
    const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
    const cameFrom = new Map<string, Vec3 | null>([[key(start), null]]);
    const queue = [start];
    while (queue.length && cameFrom.size < 3_000) {
      const p = queue.shift()!;
      for (const step of SWIM_STEPS) {
        const q = p.plus(step);
        if (cameFrom.has(key(q))) continue;
        cameFrom.set(key(q), p);
        const block = bot.blockAt(q);
        if (block?.name === "air" || block?.name === "cave_air") {
          const route = [q];
          for (let at: Vec3 | null | undefined = p; at; at = cameFrom.get(key(at))) route.unshift(at);
          return route;
        }
        // Sideways, the body (a block below the head) has to fit through too.
        const fits = step.y !== 0 || this.watery(bot.blockAt(q.offset(0, -1, 0)));
        if (this.watery(block) && fits && q.distanceTo(start) <= 16) queue.push(q);
      }
    }
    return null;
  }

  private sheltered(): boolean {
    const now = Date.now();
    if (now - this.shelterCache.at > 2_000) this.shelterCache = { at: now, value: isSheltered(this.bot) };
    return this.shelterCache.value;
  }

  /** Raises needs that take planning with Claude, each at most so often. */
  private checkNeeds() {
    const bot = this.bot;
    const { timeOfDay: t, day } = bot.time;
    const sheltered = this.sheltered();
    if (t >= 13000 && t < 23000) {
      this.nightSeen = true;
      if (sheltered || bot.isSleeping) this.shelteredTonight = true;
    }

    // Evening: once a day, from shortly before sunset on through the night.
    if (t >= 11000 && t < 23000 && this.eveningAlertDay !== day) {
      this.eveningAlertDay = day;
      if (!sheltered && !bot.isSleeping) {
        this.host.alert(
          t < 13000
            ? `The sun is setting; it'll be dark in about a minute, and hostile mobs spawn in the dark. ${readiness(bot)} Make sure you'll be safe tonight.`
            : `It's night and you're out in the open, where hostile mobs spawn. ${readiness(bot)} Get somewhere safe.`,
        );
        return;
      }
    }

    // Morning, whether it came on its own or a command set the time. Wakes an agent that
    // sheltered for the night or sat idle through it ("I'll go at dawn" needs a dawn).
    if (this.nightSeen && (t >= 23000 || t < 12000)) {
      const wasSheltered = this.shelteredTonight;
      this.nightSeen = this.shelteredTonight = false;
      if (wasSheltered || this.host.idleMs() > 20_000) {
        this.host.alert(`It's morning: the mobs are burning off and it's safe to be out. Pick up whatever you put off for the night. ${readiness(bot)}`);
        return;
      }
    }

    const hurt = bot.health <= 10 && bot.food < 18;
    if ((bot.food <= 12 || hurt) && !foods(bot).length && this.due("hungry", 180_000)) {
      this.host.alert(
        hurt
          ? `Health is ${Math.round(bot.health)}/20 and won't regenerate: that needs food at 18 or more (it's ${bot.food}/20), and you have nothing to eat. Getting food comes first: kill animals (cook the meat if you can) or gather crops, and avoid fights until you've eaten.`
          : `You're getting hungry (food ${bot.food}/20) and have nothing to eat. At 0 you start losing health. Find food: kill animals (cook the meat if you can) or gather crops.`,
      );
      return;
    }

    const missing = [
      !bestWeapon(bot) && "a weapon",
      !foods(bot).length && "food",
      shelterBlocks(bot).reduce((sum, i) => sum + i.count, 0) < 10 && "a stack of blocks like dirt or cobblestone for emergency shelters",
    ].filter(Boolean);
    if (missing.length && t < 11000 && this.host.idleMs() >= 60_000 && this.due("prepare", 600_000)) {
      this.host.alert(
        `You have nothing to do right now, and you're missing ${missing.join(", ")}. Use the time to get ready for night. Stay within about 50 blocks of here.`,
      );
    }
  }

  private due(key: string, everyMs: number): boolean {
    const now = Date.now();
    if (now - (this.lastAlert.get(key) ?? 0) < everyMs) return false;
    this.lastAlert.set(key, now);
    return true;
  }

  private onDeath() {
    const where = formatPos(this.bot.entity.position);
    log.event(`Died at ${where}.`);
    this.deathCount++;
    // A fresh life: no grudges, and no memory of being cornered (a respawned bot that
    // thinks it's cornered picks bare-handed fights).
    this.lastFailedEscape = 0;
    this.attacker = null;
    this.ignored.clear();
    this.body.interrupt(new Died());
    this.deaths.push({ at: Date.now(), where });
    if (this.deathAlertTimer) return;
    // Wait for the respawn, and fold rapid repeat deaths into one message.
    const wait = Math.max(3_000, this.lastDeathAlert + 45_000 - Date.now());
    this.deathAlertTimer = setTimeout(() => this.alertDeaths(), wait);
  }

  private alertDeaths() {
    this.deathAlertTimer = null;
    this.lastDeathAlert = Date.now();
    const deaths = this.deaths.splice(0);
    const causes = new Set(
      deaths
        .map((d) => this.aboutMe.find((m) => Math.abs(m.at - d.at) < 3_000 && !/joined|left|advancement|challenge|goal/.test(m.text))?.text)
        .filter(Boolean),
    );
    const what = deaths.length === 1 ? "You died" : `You died ${deaths.length} times in a row`;
    const text = `${what}${causes.size ? ` (${[...causes].join("; ")})` : ""}. You respawned at ${formatPos(this.bot.entity.position)} with an empty inventory. Your items dropped at ${deaths.at(-1)!.where} and vanish after 5 minutes. ${readiness(this.bot)}`;
    log.event(text);
    if (config.autonomy) this.host.alert(text);
    else this.host.report(text);
  }
}
