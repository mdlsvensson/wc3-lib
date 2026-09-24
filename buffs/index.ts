/**
 * Script buffs: `BuffStore` with refresh, replace, stack and independent stacking,
 * periodic ticks and exactly-once cleanup, plus `trackWarcraftBuffTargets`, which removes
 * buffs from dead or removed units. Auras are in `buffs/aura`.
 *
 * @example
 * ```ts
 * import { BuffStore, trackWarcraftBuffTargets, type BuffDefinition } from "@mdlsvensson/wc3-lib/buffs";
 * import { Scheduler } from "@mdlsvensson/wc3-lib/core/scheduler";
 *
 * const clock = new Scheduler();
 * const buffs = new BuffStore<unit>(clock);
 * trackWarcraftBuffTargets(buffs, clock);
 *
 * const burning: BuffDefinition<unit> = {
 *   id: "burning", kind: "active", stacking: "independent", maxStacks: 5, duration: 3, interval: 1,
 *   onTick: buff => SetWidgetLife(buff.target, GetWidgetLife(buff.target) - 10 * buff.stacks),
 * };
 * declare const target: unit;
 * buffs.apply(target, burning);
 * ```
 *
 * @module
 */

export * from "./buffs.ts";
export * from "./warcraft-buffs.ts";
