/**
 * Warcraft adapter for `BuffStore`: `trackWarcraftBuffTargets` polls buffed units and
 * removes buffs from units that died or were removed.
 *
 * @example
 * ```ts
 * import { BuffStore } from "@mdlsvensson/wc3-lib/buffs/buffs";
 * import { trackWarcraftBuffTargets } from "@mdlsvensson/wc3-lib/buffs/warcraft-buffs";
 * import { Scheduler } from "@mdlsvensson/wc3-lib/core/scheduler";
 *
 * const clock = new Scheduler();
 * const stop = trackWarcraftBuffTargets(new BuffStore<unit>(clock), clock);
 * ```
 *
 * @module
 */

import { BuffStore } from "./buffs.ts";
import { Scheduler } from "../core/scheduler.ts";

/**
 * Polls removed handles as well as deaths; no auto-detection of native ability buffs.
 * Polling (rather than a death trigger) also catches RemoveUnit, which fires no event.
 */
export function trackWarcraftBuffTargets(store: BuffStore<unit>, clock: Scheduler, interval = 0.25): () => void {
  return clock.every(interval, () => store.prune(
    target => GetUnitTypeId(target) !== 0,
    target => !IsUnitType(target, UNIT_TYPE_DEAD),
  ));
}
