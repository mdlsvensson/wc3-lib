/**
 * The damage pipeline for Warcraft: `createWarcraftDamage` builds a `DamageSystem` with
 * beforeArmor → afterArmor → observe phases, attack/damage/weapon type rewriting, per-hit
 * metadata and bounded script damage. `isLethal` checks a hit against the target's life.
 *
 * @example
 * ```ts
 * import { createWarcraftDamage } from "@mdlsvensson/wc3-lib/damage";
 *
 * const damage = createWarcraftDamage<{ kind: string }>({ onError: issue => BJDebugMsg(issue.code) });
 * damage.beforeArmor(context => {
 *   if (context.metadata?.kind === "fire") context.amount *= 1.5;
 * });
 * damage.observe(hit => BJDebugMsg(`${hit.amount} damage`));
 * damage.start(); // allocates the damage triggers
 * ```
 *
 * @module
 */

export * from "./system.ts";
export * from "./warcraft.ts";
