/**
 * Missiles for Warcraft: `MissileSystem` with swept-sphere collision (no tunnelling),
 * piercing, gravity arcs, homing and ground impact, plus `WarcraftMissilePort` and
 * `WarcraftMissileVisual`.
 *
 * @example
 * ```ts
 * import { MissileSystem, WarcraftMissilePort, WarcraftMissileVisual } from "@mdlsvensson/wc3-lib/physics/missile";
 *
 * declare const caster: unit;
 * const missiles = new MissileSystem(new WarcraftMissilePort({
 *   maxTargetRadius: 64, centerHeight: () => 60, eligible: u => IsUnitEnemy(u, GetOwningPlayer(caster)),
 * }));
 * const start = { x: GetUnitX(caster), y: GetUnitY(caster), z: 60 };
 * missiles.launch({
 *   position: start, velocity: { x: 900, y: 0, z: 0 }, radius: 16, lifetime: 2,
 *   visual: new WarcraftMissileVisual("Abilities\\Weapons\\FireBallMissile\\FireBallMissile.mdl", start),
 *   onHit: (missile, target) => BJDebugMsg(`hit ${GetUnitName(target)}`),
 * });
 * // every tick: missiles.update(dt);
 * ```
 *
 * @module
 */

export * from "./system.ts";
export * from "./warcraft.ts";
