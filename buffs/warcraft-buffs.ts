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
