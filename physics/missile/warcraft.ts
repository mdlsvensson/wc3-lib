/**
 * Warcraft adapters for `MissileSystem`: `WarcraftMissilePort` finds units along each
 * step with one reused group, and `WarcraftMissileVisual` moves a special effect.
 *
 * @example
 * ```ts
 * import { MissileSystem } from "@mdlsvensson/wc3-lib/physics/missile/system";
 * import { WarcraftMissilePort } from "@mdlsvensson/wc3-lib/physics/missile/warcraft";
 *
 * const missiles = new MissileSystem(new WarcraftMissilePort({ maxTargetRadius: 64, centerHeight: () => 60 }));
 * ```
 *
 * @module
 */

import { nonnegative, point3, type Point3 } from "../geometry.ts";
import { living } from "../warcraft-living.ts";
import type { CollisionTarget, MissilePort, MissileVisual } from "./system.ts";

/** Settings for `WarcraftMissilePort`. */
export interface WarcraftMissileQueryOptions {
  /** Hard upper bound for every eligible target's radius; required for conservative enumeration. */
  maxTargetRadius: number;
  /** Absolute world z of the collision sphere center. Caller supplies synchronized height policy. */
  centerHeight: (this: void, target: unit) => number;
  /** Collision radius of a target. Default `BlzGetUnitCollisionSize`; must not exceed `maxTargetRadius`. */
  radius?: (this: void, target: unit) => number;
  /** Extra eligibility check, e.g. enemies only. Default: every living unit. */
  eligible?: (this: void, target: unit) => boolean;
  /**
   * Absolute ground z for ground collision; see WarcraftTerrain. Omit for missiles that
   * never collide with terrain. Must be deterministic across clients.
   */
  groundHeight?: (this: void, x: number, y: number) => number;
}

/**
 * No handles allocated at construction. The first query creates one group that later queries
 * reuse (a missile queries every tick, so per-query groups churn thousands of handles a second).
 * The owning MissileSystem destroys it through dispose().
 */
export class WarcraftMissilePort implements MissilePort<unit> {
  private readonly options: WarcraftMissileQueryOptions;
  private group?: group;
  private querying = false;
  private disposed = false;
  /** Validates `maxTargetRadius`; allocates nothing. */
  constructor(options: WarcraftMissileQueryOptions) {
    nonnegative(options.maxTargetRadius, "maxTargetRadius");
    this.options = { ...options };
  }

  /** Whether the unit is alive and passes `eligible`. */
  valid(target: unit): boolean { return living(target) && (this.options.eligible?.(target) ?? true); }

  groundHeight(x: number, y: number): number | undefined { return this.options.groundHeight?.(x, y); }

  candidates(from: Point3, to: Point3, radius: number): CollisionTarget<unit>[] {
    point3(from);
    point3(to);
    nonnegative(radius, "radius");
    if (this.disposed) throw new Error("Missile query port disposed");
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const searchRadius = Math.sqrt(dx * dx + dy * dy) / 2 + radius + this.options.maxTargetRadius;
    // A policy callback that queries this same port re-enters; give that call a private group.
    const shared = !this.querying;
    if (shared && this.group === undefined) this.group = CreateGroup();
    const group = shared ? this.group : CreateGroup();
    if (group === undefined) throw new Error("Failed to create missile query group");
    if (shared) this.querying = true;
    const result: CollisionTarget<unit>[] = [];
    try {
      GroupEnumUnitsInRange(group, (from.x + to.x) / 2, (from.y + to.y) / 2, searchRadius, undefined);
      let target = FirstOfGroup(group);
      while (target !== undefined) {
        GroupRemoveUnit(group, target);
        if (this.valid(target)) {
          const targetRadius = this.options.radius?.(target) ?? BlzGetUnitCollisionSize(target);
          nonnegative(targetRadius, "target radius");
          if (targetRadius > this.options.maxTargetRadius) throw new Error("Target exceeds missile query radius bound");
          const position = { x: GetUnitX(target), y: GetUnitY(target), z: this.options.centerHeight(target) };
          point3(position);
          result.push({ target, id: GetHandleId(target), position, radius: targetRadius });
        }
        target = FirstOfGroup(group);
      }
    } catch (error) { this.release(group, shared); throw error; }
    this.release(group, shared);
    return result;
  }

  /** Clears the shared group, or destroys a private one. */
  private release(group: group, shared: boolean): void {
    if (shared) { GroupClear(group); this.querying = false; }
    else DestroyGroup(group);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.group !== undefined) DestroyGroup(this.group);
    this.group = undefined;
  }
}

/** Explicit construction creates one owned effect at absolute world height. */
export class WarcraftMissileVisual implements MissileVisual {
  private effect?: effect;
  /**
   * Creates the effect at `position`. Throws when the model path is empty or the effect cannot be created.
   * @param modelPath Effect model path.
   * @param position Absolute world position.
   */
  constructor(modelPath: string, position: Point3) {
    point3(position);
    if (modelPath.length === 0) throw new Error("Effect model path must not be empty");
    this.effect = AddSpecialEffect(modelPath, position.x, position.y);
    if (this.effect === undefined) throw new Error("Failed to create missile effect");
    try { this.move(position); }
    catch (error) { this.dispose(); throw error; }
  }

  /** Moves the effect to an absolute world position. Does nothing after `dispose()`. */
  move(position: Point3): void {
    if (this.effect === undefined) return;
    point3(position);
    BlzSetSpecialEffectPosition(this.effect, position.x, position.y, position.z);
  }

  /** Destroys the effect. Idempotent. */
  dispose(): void {
    if (this.effect === undefined) return;
    const owned = this.effect;
    this.effect = undefined;
    DestroyEffect(owned);
  }
}
