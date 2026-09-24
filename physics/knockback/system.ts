/**
 * The pure knockback core: `KnockbackSystem`, `Knockback`, `knockbackVelocity` and the
 * `KnockbackPort` a map can implement. Displacement is integrated exactly per step.
 *
 * @example
 * ```ts
 * import { KnockbackSystem, type KnockbackPort } from "@mdlsvensson/wc3-lib/physics/knockback/system";
 *
 * declare const port: KnockbackPort<string>;
 * const knockback = new KnockbackSystem(port);
 * knockback.apply("crate", { velocity: { x: 400, y: 0 }, duration: 0.25 });
 * knockback.update(1 / 32);
 * ```
 *
 * @module
 */

import { nonnegative, point2, positive, type Point2 } from "../geometry.ts";

/** Engine operations the `KnockbackSystem` needs. `WarcraftKnockbackPort` is the Warcraft one. */
export interface KnockbackPort<T> {
  /** Whether the target can still be moved. An invalid target ends its knockback with `"invalid"`. */
  valid(target: T): boolean;
  /** The target's current position. */
  position(target: T): Point2;
  /** Apply a whole movement or return false; pathing policy belongs to the adapter. */
  move(target: T, destination: Point2): boolean;
}
/** Why a knockback ended; passed to `onEnd`. */
export type KnockbackEnd = "completed" | "replaced" | "interrupted" | "invalid" | "blocked" | "disposed" | "error";
/** none: constant velocity. linear: velocity decays to zero at the end (a slide that settles). */
export type KnockbackFalloff = "none" | "linear";
/** Settings for `KnockbackSystem.apply`. */
export interface KnockbackOptions {
  /** Initial velocity in world units per second. */
  velocity: Point2;
  /** Seconds the knockback lasts; must be positive. */
  duration: number;
  /** Velocity profile. Default `"none"`. */
  falloff?: KnockbackFalloff;
  /** Runs once when the knockback ends, after the system has released the target. */
  onEnd?: (this: void, reason: KnockbackEnd) => void;
}

/**
 * The initial velocity that moves `distance` units along `angle` (radians) in `duration`
 * seconds under the given falloff. Linear falloff needs twice the start speed.
 */
export function knockbackVelocity(angle: number, distance: number, duration: number, falloff: KnockbackFalloff = "none"): Point2 {
  nonnegative(distance, "distance");
  positive(duration, "duration");
  const speed = (falloff === "linear" ? 2 : 1) * distance / duration;
  return { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed };
}

/** One target's active knockback, returned by `KnockbackSystem.apply`. */
export class Knockback<T> {
  private options?: KnockbackOptions;
  private elapsed = 0;
  /** @internal Create through KnockbackSystem.apply. */
  constructor(readonly target: T, options: KnockbackOptions, private readonly release: (item: Knockback<T>) => void) {
    this.options = { ...options, velocity: { ...options.velocity } };
  }
  /** False once the knockback has ended. */
  get active(): boolean { return this.options !== undefined; }
  /** Seconds left, or 0 once it has ended. */
  get remaining(): number { return this.options ? this.options.duration - this.elapsed : 0; }
  /** Ends the knockback with reason `"interrupted"`. */
  dispose(): void { this.finish("interrupted"); }

  /** @internal Ownership is released before callbacks. */
  finish(reason: KnockbackEnd): void {
    const options = this.options;
    if (options === undefined) return;
    this.options = undefined;
    this.release(this);
    options.onEnd?.(reason);
  }

  /** @internal */
  advance(dt: number, port: KnockbackPort<T>): void {
    const options = this.options;
    if (options === undefined) return;
    if (!port.valid(this.target)) { this.finish("invalid"); return; }
    const from = port.position(this.target);
    point2(from);
    const t0 = this.elapsed;
    const t1 = Math.min(t0 + dt, options.duration);
    // Exact displacement integral over [t0, t1]; linear: v(t) = v0 * (1 - t / duration).
    const factor = options.falloff === "linear"
      ? (t1 - t0) - (t1 * t1 - t0 * t0) / (2 * options.duration)
      : t1 - t0;
    const to = { x: from.x + options.velocity.x * factor, y: from.y + options.velocity.y * factor };
    point2(to);
    if (!port.move(this.target, to)) { this.finish("blocked"); return; }
    this.elapsed = t1;
    if (this.elapsed >= options.duration) this.finish("completed");
  }
}

/** Moves targets by their knockback each `update`. One knockback per target: a new one replaces the old. */
export class KnockbackSystem<T> {
  private readonly active = new Map<T, Knockback<T>>();
  private disposed = false;
  private updating = false;
  /**
   * Creates an empty system.
   * @param port Engine operations; see `WarcraftKnockbackPort`.
   */
  constructor(private readonly port: KnockbackPort<T>) {}
  /** Number of active knockbacks. */
  get size(): number { return this.active.size; }

  /** The knockback currently owning the target's movement, if any. */
  get(target: T): Knockback<T> | undefined { return this.active.get(target); }

  /** Starts a knockback, replacing the target's current one (reason `"replaced"`). */
  apply(target: T, options: KnockbackOptions): Knockback<T> {
    if (this.disposed) throw new Error("KnockbackSystem is disposed");
    point2(options.velocity);
    positive(options.duration, "duration");
    const previous = this.active.get(target);
    const item = new Knockback(target, options, (released) => {
      if (this.active.get(target) === released) this.active.delete(target);
    });
    // Install first: a newer apply made by the old callback replaces this item.
    this.active.set(target, item);
    try { previous?.finish("replaced"); }
    catch (error) { item.finish("error"); throw error; }
    return item;
  }

  /** A throwing item ends with "error"; the others still advance, then the first error propagates. */
  update(dt: number): void {
    nonnegative(dt, "dt");
    if (this.disposed || dt === 0) return;
    if (this.updating) throw new Error("KnockbackSystem.update cannot be reentered");
    this.updating = true;
    const errors: unknown[] = [];
    try {
      for (const item of [...this.active.values()]) {
        try { item.advance(dt, this.port); }
        catch (error) {
          errors.push(error);
          try { item.finish("error"); } catch (cleanupError) { errors.push(cleanupError); }
        }
      }
    } catch (error) { this.updating = false; throw error; }
    this.updating = false;
    if (errors.length > 0) throw errors[0];
  }

  /** Ends every knockback with reason `"disposed"`. Applying afterwards throws. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (const item of [...this.active.values()]) {
      try { item.finish("disposed"); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw errors[0];
  }
}
