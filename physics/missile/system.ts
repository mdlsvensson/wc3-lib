/**
 * The pure missile core: `MissileSystem`, `Missile` and the `MissilePort` and
 * `MissileVisual` a map can implement. Deterministic: contacts are ordered by fraction, then id.
 *
 * @example
 * ```ts
 * import { MissileSystem, type MissilePort } from "@mdlsvensson/wc3-lib/physics/missile/system";
 *
 * declare const port: MissilePort<string>;
 * const missiles = new MissileSystem(port);
 * missiles.launch({ position: { x: 0, y: 0, z: 0 }, velocity: { x: 500, y: 0, z: 0 }, radius: 8, lifetime: 1 });
 * missiles.update(1 / 32);
 * ```
 *
 * @module
 */

import { finite, interpolate, length3, nonnegative, point3, positive, segmentSphere, type Point3 } from "../geometry.ts";

/** A collision candidate returned by `MissilePort.candidates`. */
export interface CollisionTarget<T> {
  /** Stable unique identifier, also used to break simultaneous contact ties. */
  id: number;
  /** The target itself, passed to `onHit`. */
  target: T;
  /** Center of the target's collision sphere. */
  position: Point3;
  /** Radius of the target's collision sphere. */
  radius: number;
}

/** Engine operations a `MissileSystem` needs. `WarcraftMissilePort` is the Warcraft one. */
export interface MissilePort<T> {
  /** Return a conservative superset along the whole segment, including target radii. */
  candidates(from: Point3, to: Point3, radius: number): CollisionTarget<T>[];
  /** Whether the target can still be hit. */
  valid(target: T): boolean;
  /** Optional absolute ground height. A missile whose center ends a step below it ends with "ground". */
  groundHeight?(x: number, y: number): number | undefined;
  /** The system owns its port: MissileSystem.dispose calls this once. */
  dispose?(): void;
}

/** What a missile looks like. The missile moves it each step and disposes it when it ends. */
export interface MissileVisual {
  /** Moves the visual to the missile's position. */
  move(position: Point3): void;
  /** Removes the visual. */
  dispose(): void;
}

/**
 * hit-limit: reached maxHits. expired: lifetime ran out. range: maxRange travelled.
 * ground: fell below port.groundHeight. cancelled: Missile.dispose(). disposed: system shutdown.
 * error: a callback or port call threw while advancing this missile.
 */
export type MissileEnd = "hit-limit" | "expired" | "range" | "ground" | "cancelled" | "disposed" | "error";

/** Settings for `MissileSystem.launch`. */
export interface MissileOptions<T> {
  /** Start position. */
  position: Point3;
  /** World units per second. */
  velocity: Point3;
  /** Collision radius; must not be negative. */
  radius: number;
  /** Required finite lifetime in seconds, including stationary missiles. */
  lifetime: number;
  /** Distance in world units after which the missile ends with `"range"`. */
  maxRange?: number;
  /** Total distinct targets, default 1; piercing is maxHits > 1. */
  maxHits?: number;
  /** Constant acceleration in units/s², e.g. gravity { x: 0, y: 0, z: -2000 } for an arc. */
  acceleration?: Point3;
  /**
   * Runs first in every step, with that step's seconds. Set missile.velocity here for homing
   * (see turnToward in geometry.ts) or dispose the missile. It must be deterministic.
   */
  steer?: (this: void, missile: Missile<T>, dt: number) => void;
  /** Ownership transfers after validation; disposal occurs exactly once. */
  visual?: MissileVisual;
  /** Runs for each new target hit, in contact order (then by candidate id). */
  onHit?: (this: void, missile: Missile<T>, target: T) => void;
  /** Called exactly once, after the visual is disposed. missile.position is the final position. */
  onEnd?: (this: void, missile: Missile<T>, reason: MissileEnd) => void;
}

interface Contact<T> { candidate: CollisionTarget<T>; fraction: number }

/** Explicit comparisons: `a - b || c - d` is wrong in Lua, where 0 is truthy. */
function contactOrder<T>(a: Contact<T>, b: Contact<T>): number {
  if (a.fraction !== b.fraction) return a.fraction < b.fraction ? -1 : 1;
  if (a.candidate.id !== b.candidate.id) return a.candidate.id < b.candidate.id ? -1 : 1;
  return 0;
}

function validVelocity(velocity: Point3, name: string): void {
  point3(velocity);
  finite(velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z, `squared ${name}`);
}

/** A missile in flight, returned by `MissileSystem.launch`. */
export class Missile<T> {
  private current: Point3;
  private currentVelocity: Point3;
  private options?: MissileOptions<T>;
  private readonly hits = new Set<number>();
  private elapsed = 0;
  private distance = 0;

  /** @internal Create through MissileSystem.launch. */
  constructor(options: MissileOptions<T>, private readonly release: (missile: Missile<T>) => void) {
    this.current = { ...options.position };
    this.currentVelocity = { ...options.velocity };
    this.options = { ...options, position: { ...options.position }, velocity: { ...options.velocity },
      acceleration: options.acceleration ? { ...options.acceleration } : undefined };
  }

  /** False once the missile has ended. */
  get active(): boolean { return this.options !== undefined; }
  /** Current position (a copy). */
  get position(): Point3 { return { ...this.current }; }
  /** Current velocity (a copy). Assign a new velocity to steer; it must be finite. */
  get velocity(): Point3 { return { ...this.currentVelocity }; }
  set velocity(value: Point3) {
    validVelocity(value, "velocity");
    this.currentVelocity = { ...value };
  }
  /** Seconds this missile has flown. */
  get age(): number { return this.elapsed; }
  /** Distance flown so far. */
  get travelled(): number { return this.distance; }
  /** Number of distinct targets hit. */
  get hitCount(): number { return this.hits.size; }

  /** Ends the missile with reason `"cancelled"`. */
  dispose(): void { this.finish("cancelled"); }

  /** @internal Releases ownership before any callback, so callbacks may launch or dispose freely. */
  finish(reason: MissileEnd): void {
    const options = this.options;
    if (options === undefined) return;
    this.options = undefined;
    this.hits.clear();
    this.release(this);
    try { options.visual?.dispose(); }
    catch (error) { options.onEnd?.(this, reason); throw error; }
    options.onEnd?.(this, reason);
  }

  /** @internal The system snapshots membership once per update. */
  advance(dt: number, port: MissilePort<T>): void {
    let options = this.options;
    if (options === undefined) return;
    let seconds = Math.min(dt, options.lifetime - this.elapsed);
    if (options.steer) {
      options.steer(this, seconds);
      options = this.options;
      if (options === undefined) return;
    }
    const acceleration = options.acceleration;
    if (acceleration) {
      // Semi-implicit Euler: velocity first, then position. Stable and identical on every client.
      this.velocity = { x: this.currentVelocity.x + acceleration.x * seconds, y: this.currentVelocity.y + acceleration.y * seconds,
        z: this.currentVelocity.z + acceleration.z * seconds };
    }
    const velocity = this.currentVelocity;
    const speed = length3(velocity);
    if (options.maxRange !== undefined && speed > 0) seconds = Math.min(seconds, (options.maxRange - this.distance) / speed);
    const from = this.current;
    const to = { x: from.x + velocity.x * seconds, y: from.y + velocity.y * seconds, z: from.z + velocity.z * seconds };
    point3(to);
    const collisions: Contact<T>[] = [];
    for (const candidate of port.candidates({ ...from }, { ...to }, options.radius)) {
      finite(candidate.id, "candidate id");
      point3(candidate.position);
      nonnegative(candidate.radius, "candidate radius");
      const fraction = segmentSphere(from, to, candidate.position, options.radius + candidate.radius);
      if (fraction !== undefined) collisions.push({ candidate, fraction });
    }
    collisions.sort((a, b) => contactOrder(a, b));
    for (const collision of collisions) {
      if (!this.active) return;
      const candidate = collision.candidate;
      if (this.hits.has(candidate.id) || !port.valid(candidate.target)) continue;
      this.hits.add(candidate.id);
      this.current = interpolate(from, to, collision.fraction);
      options.visual?.move(this.position);
      if (!this.active) return;
      options.onHit?.(this, candidate.target);
      if (!this.active) return;
      if (this.hits.size >= (options.maxHits ?? 1)) { this.finish("hit-limit"); return; }
    }
    if (!this.active) return;
    // Ground is checked at the step end only, so a hit later in the same step still counts.
    const ground = port.groundHeight?.(to.x, to.y);
    this.current = ground !== undefined && to.z < ground ? { x: to.x, y: to.y, z: ground } : to;
    this.elapsed += seconds;
    this.distance += speed * seconds;
    options.visual?.move(this.position);
    if (!this.active) return;
    if (ground !== undefined && to.z < ground) this.finish("ground");
    else if (this.elapsed >= options.lifetime) this.finish("expired");
    else if (options.maxRange !== undefined && this.distance >= options.maxRange) this.finish("range");
  }
}

/** Advances missiles each `update`. Create one system per feature or team; eligibility is port policy. */
export class MissileSystem<T> {
  private readonly missiles = new Set<Missile<T>>();
  private disposed = false;
  private updating = false;

  /** The system takes ownership of the port (see MissilePort.dispose). */
  constructor(private readonly port: MissilePort<T>) {}
  /** Number of missiles in flight. */
  get size(): number { return this.missiles.size; }

  /** Validates the options and launches a missile. It moves on the next `update`. */
  launch(options: MissileOptions<T>): Missile<T> {
    if (this.disposed) throw new Error("MissileSystem is disposed");
    point3(options.position);
    validVelocity(options.velocity, "speed");
    if (options.acceleration !== undefined) validVelocity(options.acceleration, "acceleration");
    nonnegative(options.radius, "radius");
    positive(options.lifetime, "lifetime");
    if (options.maxRange !== undefined) positive(options.maxRange, "maxRange");
    const maxHits = options.maxHits ?? 1;
    positive(maxHits, "maxHits");
    if (Math.floor(maxHits) !== maxHits) throw new Error("maxHits must be an integer");
    const missile = new Missile(options, (item) => this.missiles.delete(item));
    this.missiles.add(missile);
    return missile;
  }

  /**
   * Reentrant updates throw. A throwing missile ends with "error"; the others still advance,
   * then the first error propagates.
   */
  update(dt: number): void {
    nonnegative(dt, "dt");
    if (this.disposed || dt === 0) return;
    if (this.updating) throw new Error("MissileSystem.update cannot be reentered");
    this.updating = true;
    const errors: unknown[] = [];
    try {
      for (const missile of [...this.missiles]) {
        try { missile.advance(dt, this.port); }
        catch (error) {
          errors.push(error);
          try { missile.finish("error"); } catch (cleanupError) { errors.push(cleanupError); }
        }
      }
    } catch (error) { this.updating = false; throw error; }
    this.updating = false;
    if (errors.length > 0) throw errors[0];
  }

  /** Ends every missile with reason `"disposed"`, then disposes the port. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (const missile of [...this.missiles]) {
      try { missile.finish("disposed"); } catch (error) { errors.push(error); }
    }
    try { this.port.dispose?.(); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw errors[0];
  }
}
