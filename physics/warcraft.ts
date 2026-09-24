import { nonnegative, point2, point3, positive, type Point2, type Point3 } from "./geometry.ts";
import type { KnockbackPort } from "./knockback.ts";
import type { CollisionTarget, MissilePort, MissileVisual } from "./missile.ts";

function living(target: unit): boolean {
  return GetUnitTypeId(target) !== 0 && GetWidgetLife(target) > 0.405 && !IsUnitType(target, UNIT_TYPE_DEAD);
}

export interface WarcraftMissileQueryOptions {
  /** Hard upper bound for every eligible target's radius; required for conservative enumeration. */
  maxTargetRadius: number;
  /** Absolute world z of the collision sphere center. Caller supplies synchronized height policy. */
  centerHeight: (this: void, target: unit) => number;
  radius?: (this: void, target: unit) => number;
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
  constructor(options: WarcraftMissileQueryOptions) {
    nonnegative(options.maxTargetRadius, "maxTargetRadius");
    this.options = { ...options };
  }

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

/**
 * Terrain height sampling through one owned location (GetLocationZ has no x/y variant).
 * Explicitly constructed; dispose() removes the location. Heights can differ between clients
 * under async terrain deformation, so avoid deformation effects where ground collision matters.
 */
export class WarcraftTerrain {
  private location?: location;
  height(x: number, y: number): number {
    if (this.location === undefined) {
      // Cast: under `deno check` the DOM's Location class shadows the Warcraft Location() native.
      this.location = (Location as unknown as (x: number, y: number) => location | undefined)(x, y);
      if (this.location === undefined) throw new Error("Failed to create terrain sample location");
    } else MoveLocation(this.location, x, y);
    return GetLocationZ(this.location);
  }
  dispose(): void {
    if (this.location !== undefined) RemoveLocation(this.location);
    this.location = undefined;
  }
}

/** Explicit construction creates one owned effect at absolute world height. */
export class WarcraftMissileVisual implements MissileVisual {
  private effect?: effect;
  constructor(modelPath: string, position: Point3) {
    point3(position);
    if (modelPath.length === 0) throw new Error("Effect model path must not be empty");
    this.effect = AddSpecialEffect(modelPath, position.x, position.y);
    if (this.effect === undefined) throw new Error("Failed to create missile effect");
    try { this.move(position); }
    catch (error) { this.dispose(); throw error; }
  }

  move(position: Point3): void {
    if (this.effect === undefined) return;
    point3(position);
    BlzSetSpecialEffectPosition(this.effect, position.x, position.y, position.z);
  }

  dispose(): void {
    if (this.effect === undefined) return;
    const owned = this.effect;
    this.effect = undefined;
    DestroyEffect(owned);
  }
}

export interface WarcraftKnockbackOptions {
  /** Point sampling ignores footprints, units and destructibles. Custom policy may check those. */
  pathing: "unrestricted" | "terrain-point" | ((this: void, target: unit, from: Point2, to: Point2) => boolean);
  /** Maximum gap between terrain samples in world units; default 32. Moves over 4096 samples are blocked. */
  sampleStep?: number;
}

/** Sets x/y directly; never pauses/unpauses, changes orders, or changes unit pathing flags. */
export class WarcraftKnockbackPort implements KnockbackPort<unit> {
  private readonly options: WarcraftKnockbackOptions;
  constructor(options: WarcraftKnockbackOptions) {
    positive(options.sampleStep ?? 32, "sampleStep");
    this.options = { ...options };
  }

  valid(target: unit): boolean { return living(target); }
  position(target: unit): Point2 { return { x: GetUnitX(target), y: GetUnitY(target) }; }

  move(target: unit, to: Point2): boolean {
    point2(to);
    const from = this.position(target);
    const policy = this.options.pathing;
    if (typeof policy === "function") {
      if (!policy(target, from, to)) return false;
    } else if (policy === "terrain-point") {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const samples = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / (this.options.sampleStep ?? 32)));
      if (samples > 4096) return false;
      for (let sample = 1; sample <= samples; sample++) {
        if (IsTerrainPathable(from.x + dx * sample / samples, from.y + dy * sample / samples, PATHING_TYPE_WALKABILITY)) return false;
      }
    }
    SetUnitX(target, to.x);
    SetUnitY(target, to.y);
    return true;
  }
}
