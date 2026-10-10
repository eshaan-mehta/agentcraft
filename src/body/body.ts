import type { Bot } from "mineflayer";
import { setTimeout as sleep } from "node:timers/promises";
import { Interrupted, Preempted } from "../errors.js";

export type Priority = "task" | "reflex";
const RANK: Record<Priority, number> = { task: 1, reflex: 2 };

export interface Lease {
  readonly owner: string;
  /** Aborts when the lease is taken away (Preempted) or the holder's own signal fires. */
  readonly signal: AbortSignal;
  release(): void;
}

interface Holder {
  owner: string;
  priority: Priority;
  controller: AbortController;
  released: Promise<void>;
}

/**
 * The one owner of the bot's body. Anything that moves, digs, places, or uses items
 * holds a lease. A reflex preempts a task (the task's signal aborts with Preempted);
 * a task waits for a reflex to finish. Releasing a lease always leaves the body
 * stopped and the pathfinder clean, so one action can't sabotage the next.
 */
export class Body {
  private holder: Holder | null = null;

  constructor(readonly bot: Bot) {}

  /** Who has the body right now, e.g. "task:gather" or "reflex:fight". */
  get owner(): string | null {
    return this.holder?.owner ?? null;
  }

  async acquire(owner: string, priority: Priority, signal?: AbortSignal): Promise<Lease> {
    while (this.holder) {
      if (signal?.aborted) throw new Interrupted();
      const current = this.holder;
      const outranks = RANK[priority] > RANK[current.priority];
      if (outranks) current.controller.abort(new Preempted(owner.replace(/^\w+:/, "")));
      // A holder that ignores its signal (stuck in an uncancellable call) loses the body after 3s.
      const forced = await Promise.race([current.released.then(() => false), sleep(3_000).then(() => true)]);
      if (forced && outranks && this.holder === current) this.holder = null;
    }
    if (signal?.aborted) throw new Interrupted();

    const controller = new AbortController();
    const relay = () => controller.abort(signal!.reason);
    signal?.addEventListener("abort", relay, { once: true });
    let markReleased!: () => void;
    const holder: Holder = { owner, priority, controller, released: new Promise<void>((r) => (markReleased = r)) };
    this.holder = holder;
    return {
      owner,
      signal: controller.signal,
      release: () => {
        signal?.removeEventListener("abort", relay);
        if (this.holder === holder) {
          this.halt();
          this.holder = null;
        }
        markReleased();
      },
    };
  }

  /** Runs `action` while holding the body, releasing it afterwards no matter what. */
  async with<T>(owner: string, priority: Priority, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>) {
    const lease = await this.acquire(owner, priority, signal);
    try {
      return await action(lease.signal);
    } finally {
      lease.release();
    }
  }

  /** Cancels whatever holds the body, with `reason` as the error it sees, and stops moving. */
  interrupt(reason: Interrupted) {
    this.holder?.controller.abort(reason);
    this.halt();
  }

  /**
   * Stops movement and any action in progress. Uses setGoal(null), never
   * pathfinder.stop(): stop() sets a flag that, when nothing is moving, cancels the
   * *next* path instead.
   */
  halt() {
    const bot = this.bot;
    bot.pathfinder.setGoal(null);
    bot.stopDigging();
    bot.clearControlStates();
    if (bot.usingHeldItem) bot.deactivateItem();
  }
}
