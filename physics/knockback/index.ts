/**
 * Knockback for Warcraft units: `KnockbackSystem`, `knockbackVelocity` and
 * `WarcraftKnockbackPort` with an explicit pathing policy. One knockback per target.
 *
 * @example
 * ```ts
 * import { KnockbackSystem, knockbackVelocity, WarcraftKnockbackPort } from "@mdlsvensson/wc3-lib/physics/knockback";
 *
 * const knockback = new KnockbackSystem(new WarcraftKnockbackPort({ pathing: "terrain-point" }));
 * declare const target: unit;
 * knockback.apply(target, { velocity: knockbackVelocity(0, 300, 0.5, "linear"), duration: 0.5, falloff: "linear" });
 * // every tick: knockback.update(dt);
 * ```
 *
 * @module
 */

export * from "./system.ts";
export * from "./warcraft.ts";
