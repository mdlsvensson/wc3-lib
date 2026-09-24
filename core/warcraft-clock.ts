/**
 * Warcraft adapter for `Scheduler`: `startWarcraftClock` creates one repeating timer
 * that advances the clock every step. Importing it allocates nothing.
 *
 * @example
 * ```ts
 * import { Scheduler } from "@mdlsvensson/wc3-lib/core/scheduler";
 * import { startWarcraftClock } from "@mdlsvensson/wc3-lib/core/warcraft-clock";
 *
 * const clock = new Scheduler();
 * const stop = startWarcraftClock(clock);
 * ```
 *
 * @module
 */

import { Scheduler } from "./scheduler.ts";

/** Explicitly owns one Warcraft timer; importing this module allocates nothing. */
export function startWarcraftClock(clock: Scheduler): () => void {
  let handle: timer | undefined = CreateTimer();
  TimerStart(handle, clock.stepSeconds, true, () => clock.advance());
  return () => {
    if (!handle) return;
    PauseTimer(handle);
    DestroyTimer(handle);
    handle = undefined;
  };
}
