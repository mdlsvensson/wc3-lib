/**
 * Dummy casters: `DummyManager` leases a fresh unit per cast and removes it after the
 * cast's duration; `createWarcraftDummies` wires it to Warcraft. The caster is kept for
 * damage attribution through `sourceOf`.
 *
 * @example
 * ```ts
 * import { Scheduler } from "@mdlsvensson/wc3-lib/core/scheduler";
 * import { createWarcraftDummies } from "@mdlsvensson/wc3-lib/dummy";
 *
 * const dummies = createWarcraftDummies(new Scheduler());
 * declare const caster: unit, target: unit;
 * dummies.cast({
 *   owner: GetOwningPlayer(caster), rawcode: FourCC("dumy"), x: GetUnitX(caster), y: GetUnitY(caster),
 *   ability: FourCC("ACtb"), order: "creepthunderbolt", target, duration: 2, source: caster,
 * });
 * ```
 *
 * @module
 */

export * from "./dummy.ts";
export * from "./warcraft-dummy.ts";
