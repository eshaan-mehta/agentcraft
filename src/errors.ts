export type FailureCode =
  | "UNREACHABLE" // no route exists
  | "STUCK" // stopped making progress
  | "TIMEOUT" // ran past its time limit
  | "NOT_FOUND" // nothing matching nearby
  | "MISSING_ITEMS" // lacks ingredients, blocks, fuel...
  | "MISSING_TOOL" // can't harvest without a better tool
  | "OUT_OF_REACH" // too far to touch
  | "INVALID" // bad name or arguments
  | "BLOCKED" // something is in the way
  | "FAILED"; // the game didn't do what was asked

/** An expected failure, with a code and message written for the agent to act on. */
export class ActionError extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** The current action was cancelled: the supervisor said stop, or the task was abandoned. */
export class Interrupted extends Error {
  readonly code: string = "INTERRUPTED";
  constructor(message = "Interrupted by the supervisor.") {
    super(message);
  }
}

/** A survival reflex took the body away from the current action. */
export class Preempted extends Interrupted {
  readonly code = "PREEMPTED";
  constructor(by: string) {
    super(`Interrupted: your survival reflexes took over (${by}). See the [survival] note for what happened.`);
  }
}

/** The bot died while the action was running. */
export class Died extends Interrupted {
  readonly code = "DIED";
  constructor() {
    super("You died while doing this. See the [survival] note for what happened.");
  }
}

/** The error to throw for an aborted signal: whatever it was aborted with, or a plain interrupt. */
export function abortError(signal: AbortSignal): Interrupted {
  return signal.reason instanceof Interrupted ? signal.reason : new Interrupted();
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
