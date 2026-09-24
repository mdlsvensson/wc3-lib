/**
 * The shared clock: a deterministic fixed-step `Scheduler` and `startWarcraftClock`,
 * which drives it from one Warcraft timer. `Scope` and `Signal` are separate opt-in entry points.
 *
 * @example
 * ```ts
 * import { Scheduler, startWarcraftClock } from "@mdlsvensson/wc3-lib/core";
 *
 * const clock = new Scheduler(); // 1/32 s ticks
 * const cancel = clock.every(1, () => BJDebugMsg(`${clock.elapsed} s`));
 * const stop = startWarcraftClock(clock); // allocates the one timer
 * // later: cancel(); stop(); clock.dispose();
 * ```
 *
 * @module
 */

export * from "./scheduler.ts";
export * from "./warcraft-clock.ts";
