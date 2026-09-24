import { finite, interpolate, length3, nonnegative, point3, positive, segmentSphere, type Point3 } from "./geometry.ts";

export interface CollisionTarget<T> {
  /** Stable unique identifier, also used to break simultaneous contact ties. */
  id: number;
  target: T;
  position: Point3;
  radius: number;
}

export interface MissilePort<T> {
  /** Return a conservative superset along the whole segment, including target radii. */
  candidates(from: Point3, to: Point3, radius: number): CollisionTarget<T>[];
  valid(target: T): boolean;
  /** Optional absolute ground height. A missile whose center ends a step below it ends with "ground". */
  groundHeight?(x: number, y: number): number | undefined;
  /** The system owns its port: MissileSystem.dispose calls this once. */
  dispose?(): void;
}

export interface MissileVisual {
  move(position: Point3): void;
  dispose(): void;
}

/**
 * hit-limit: reached maxHits. expired: lifetime ran out. range: maxRange travelled.
 * ground: fell below port.groundHeight. cancelled: Missile.dispose(). disposed: system shutdown.
 * error: a callback or port call threw while advancing this missile.
 */
export type MissileEnd = "hit-limit" | "expired" | "range" | "ground" | "cancelled" | "disposed" | "error";

export interface MissileOptions<T> {
  position: Point3;
  /** World units per second. */
  velocity: Point3;
  radius: number;
  /** Required finite lifetime in seconds, including stationary missiles. */
  lifetime: number;
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

  get active(): boolean { return this.options !== undefined; }
  get position(): Point3 { return { ...this.current }; }
  get velocity(): Point3 { return { ...this.currentVelocity }; }
  set velocity(value: Point3) {
    validVelocity(value, "velocity");
    this.currentVelocity = { ...value };
  }
  /** Seconds this missile has flown. */
  get age(): number { return this.elapsed; }
  get travelled(): number { return this.distance; }
  get hitCount(): number { return this.hits.size; }

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

export class MissileSystem<T> {
  private readonly missiles = new Set<Missile<T>>();
  private disposed = false;
  private updating = false;

  /** The system takes ownership of the port (see MissilePort.dispose). */
  constructor(private readonly port: MissilePort<T>) {}
  get size(): number { return this.missiles.size; }

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
