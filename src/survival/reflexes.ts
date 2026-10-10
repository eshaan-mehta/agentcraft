// Keeps the bot alive no matter what Claude is doing. Reflexes (fight, flee, eat,
// wear armor, stay afloat) run in code every half second and take the body from
// whatever task holds it. Needs that take planning (night is coming, no food, just
// died, idle without basics) are raised with Claude as [survival] messages.
import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { setTimeout as sleep } from "node:timers/promises";
import type { Body } from "../body/body.js";
import type { Motor } from "../body/motor.js";
import { config } from "../config.js";
import { errorText } from "../errors.js";
import { log } from "../log.js";
import { bestWeapon, distanceTo, equipment, foods, formatPos, isHostile, isSheltered, readiness, shelterBlocks } from "../world/perception.js";

const { goals } = pathfinderPkg;
type Entity = Bot["entity"];
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
const EAT_AT_FOOD = 14;
const STARVING = 6; // at or below this, eat even if it interrupts a task

const ARMOR_TIERS = ["leather", "golden", "copper", "chainmail", "iron", "diamond", "netherite"];
const ARMOR = [
  { suffix: "_helmet", slot: "head" },
  { suffix: "_chestplate", slot: "torso" },
  { suffix: "_leggings", slot: "legs" },
  { suffix: "_boots", slot: "feet" },
] as const;

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
  private deaths: { at: number; where: string }[] = [];
  private deathAlertTimer: NodeJS.Timeout | null = null;
  private lastDeathAlert = 0;
  private aboutMe: { text: string; at: number }[] = [];

  constructor(
    private readonly bot: Bot,
    private readonly body: Body,
    private readonly motor: Motor,
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

    const threats = this.threats();
    if (threats.length) {
      const flee = this.fleeReason(threats);
      // If a task is already fighting, let it, unless it's time to run.
      if (!flee && this.body.owner?.startsWith("task:") && /attack|fight|hunt/.test(this.body.owner)) return;
      return this.takeOver(flee ? "flee" : "fight", () => (flee ? this.flee(flee.from, flee.reason) : this.fightBack(threats[0]!)));
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
  private takeOver(name: string, run: () => Promise<Outcome>) {
    this.busy = true;
    void (async () => {
      try {
        const outcome = await this.body.with(`reflex:${name}`, "reflex", undefined, () => run());
        if (outcome) {
          log.event(`Reflex: ${outcome.text}`);
          // A run of the same thing (several fights, several bites) is reported once.
          if (Date.now() - (this.lastReport.get(outcome.kind) ?? 0) > 15_000) this.host.report(outcome.text);
          this.lastReport.set(outcome.kind, Date.now());
        }
      } catch (err) {
        log.error(`Survival reflex failed: ${errorText(err)}`, err);
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
        if (e === bot.entity || !e.isValid || (this.ignored.get(e.id) ?? 0) > now) return false;
        const d = e.position.distanceTo(me);
        // Whatever just hit us, even if it's normally peaceful (a provoked enderman, a wolf).
        if (e === recent) return e.type !== "player" && d <= ATTACKER_RANGE;
        if (RUN_FROM.has(e.name ?? "")) return d <= RUN_FROM_RANGE;
        if (!isHostile(e)) return false;
        return d <= THREAT_RANGE && Math.abs(e.position.y - me.y) <= 4; // not one in a cave below
      })
      .sort((a, b) => (a === recent ? -1 : b === recent ? 1 : a.position.distanceTo(me) - b.position.distanceTo(me)));
    // Walled in, nothing can reach us; never break out to chase or run. Checked fresh
    // (not cached) since the bot may have just sealed itself in.
    if (threats.length && isSheltered(bot)) return [];
    return threats;
  }

  private fleeReason(threats: Entity[]): { from: Entity; reason: string } | null {
    const bot = this.bot;
    const health = Math.round(bot.health);
    const runFrom = threats.find((e) => RUN_FROM.has(e.name ?? ""));
    if (runFrom) return { from: runFrom, reason: `a ${runFrom.name} got within ${distanceTo(bot, runFrom.position).toFixed(0)}m` };
    // Cornered recently: running didn't work, so fight instead.
    if (Date.now() - this.lastFailedEscape < 15_000) return null;
    const nearest = threats[0]!;
    if (health <= LOW_HEALTH) return { from: nearest, reason: `health was down to ${health}/20` };
    // Fists do 1 damage: a bare-handed fight with a zombie costs most of your health.
    if (!bestWeapon(bot)) return { from: nearest, reason: "you have no weapon" };
    const crowd = threats.filter((e) => distanceTo(bot, e.position) <= 8).length;
    if (crowd >= 3 && health <= 14) return { from: nearest, reason: `${crowd} hostile mobs closed in at health ${health}/20` };
    return null;
  }

  private async fightBack(target: Entity): Promise<Outcome> {
    const bot = this.bot;
    log.event(`Reflex: fighting a ${target.name} ${distanceTo(bot, target.position).toFixed(0)}m away (health ${Math.round(bot.health)}/20)`);
    const cornered = Date.now() - this.lastFailedEscape < 15_000;
    const result = await this.motor.fight(target, { timeoutMs: 20_000, stopAtHealth: cornered ? undefined : LOW_HEALTH });
    const health = Math.round(bot.health);
    if (result === "killed") return { kind: "fight", text: `Killed a ${target.name} that came at you. Health ${health}/20.` };
    if (result === "low_health") return this.flee(target, `health dropped to ${health}/20 fighting a ${target.name}`);
    // Couldn't reach it (up a ledge, down a drop, across water): leave it alone for a while.
    this.ignored.set(target.id, Date.now() + 30_000);
    const why = result === "lost" ? "it got away" : "couldn't reach it";
    return { kind: "fight", text: `Went after a ${target.name} but ${why}; it's at ${formatPos(target.position)}. Health ${health}/20.` };
  }

  private async flee(from: Entity, reason: string): Promise<Outcome> {
    const bot = this.bot;
    log.event(`Reflex: running from a ${from.name} because ${reason}`);
    const away = new goals.GoalInvert(new goals.GoalFollow(from, 16));
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && from.isValid && distanceTo(bot, from.position) < 16) {
      // Re-assert each round: a just-cancelled action can clear the goal late.
      if (bot.pathfinder.goal !== away) bot.pathfinder.setGoal(away, true);
      await sleep(250);
    }
    bot.pathfinder.setGoal(null);
    const escaped = !from.isValid || distanceTo(bot, from.position) >= 16;
    if (!escaped) this.lastFailedEscape = Date.now();
    const health = Math.round(bot.health);
    return {
      kind: "flee",
      text: `${escaped ? "Ran" : "Tried to run"} from a ${from.name} because ${reason}. Now at ${formatPos(bot.entity.position)}, health ${health}/20.`,
    };
  }

  private foodToEat(): string | null {
    const bot = this.bot;
    if (Date.now() - this.lastEatAttempt < 3_000 || bot.food >= 20) return null;
    const hungry = bot.food <= EAT_AT_FOOD || (bot.health <= 14 && bot.food < 18); // health only regenerates at 18+ food
    if (!hungry) return null;
    // Don't interrupt a task for a snack: wait for a gap, unless starving.
    if (this.body.owner && bot.food > STARVING) return null;
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
    const eyes = bot.blockAt(bot.entity.position.offset(0, 1.62, 0));
    const swim = eyes?.name === "water" && !bot.pathfinder.isMoving();
    if (swim !== this.swimming) {
      bot.setControlState("jump", swim);
      this.swimming = swim;
    }
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
    if (t >= 13000 && t < 23000 && (sheltered || bot.isSleeping)) this.shelteredTonight = true;

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

    if (this.shelteredTonight && (t >= 23000 || t < 1000)) {
      this.shelteredTonight = false;
      this.host.alert(`It's morning: the mobs are burning off and it's safe to come out. ${readiness(bot)}`);
      return;
    }

    if (bot.food <= 12 && !foods(bot).length && this.due("hungry", 180_000)) {
      this.host.alert(
        `You're getting hungry (food ${bot.food}/20) and have nothing to eat. At 0 you start losing health. Find food: kill animals (cook the meat if you can) or gather crops.`,
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
    this.body.halt();
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
