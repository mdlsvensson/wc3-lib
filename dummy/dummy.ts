/**
 * The pure dummy core: `DummyManager`, `DummyLease` and the `DummyPort` a map can
 * implement. No pooling: every cast gets a fresh unit.
 *
 * @example
 * ```ts
 * import { Scheduler } from "@mdlsvensson/wc3-lib/core/scheduler";
 * import { DummyManager, type DummyPort } from "@mdlsvensson/wc3-lib/dummy/dummy";
 *
 * declare const port: DummyPort<unit, player>;
 * const dummies = new DummyManager(new Scheduler(), port);
 * ```
 *
 * @module
 */

import { Scheduler, type Cancel } from "../core/scheduler.ts";

/** A request to create a dummy unit and have it cast one ability. */
export interface DummyCast<U, P> {
  /** Player that owns the dummy. */
  readonly owner: P;
  /** Unit type of the dummy (a map-supplied rawcode). */
  readonly rawcode: number;
  /** Spawn x. */
  readonly x: number;
  /** Spawn y. */
  readonly y: number;
  /** Facing in degrees. Default 0. */
  readonly facing?: number;
  /** Ability rawcode to add and cast. */
  readonly ability: number;
  /** Ability level. Default 1. */
  readonly level?: number;
  /** Order string, e.g. `"thunderbolt"` (creep abilities use `creep`-prefixed orders). */
  readonly order: string;
  /** Unit target for a target order. Set `target` or `point`, not both. */
  readonly target?: U;
  /** Point target for a point order. With neither `target` nor `point`, an immediate order is issued. */
  readonly point?: { x: number; y: number };
  /**
   * Must include cast point, channel time AND projectile travel: removing the dummy early
   * cancels channels, and damage arriving after removal can no longer be attributed.
   */
  readonly duration: number;
  /** The real caster. Damage handlers resolve dummy → caster with DummyManager.sourceOf. */
  readonly source?: U;
}

/** Engine operations the `DummyManager` needs. `createWarcraftDummies` supplies the Warcraft one. */
export interface DummyPort<U, P> {
  /** Creates the dummy unit, or returns undefined on failure. */
  create(request: DummyCast<U, P>): U | undefined;
  /** Prepares the dummy (locust, invulnerability, ability, mana). Throw to abort the cast. */
  configure(unit: U, request: DummyCast<U, P>): void;
  /** Issues the order. Returns whether the engine accepted it. */
  order(unit: U, request: DummyCast<U, P>): boolean;
  /** Removes the dummy unit. */
  remove(unit: U): void;
}

/** Ownership of one live dummy. Disposing it (or its lifetime running out) removes the unit. */
export class DummyLease<U> {
  private live = true;
  private cancel?: Cancel;
  private accepted = false;
  /**
   * Created by `DummyManager.cast`.
   * @param unit The dummy unit.
   * @param release Removes the unit and forgets the lease.
   * @param source The real caster, if one was given.
   */
  constructor(readonly unit: U, private readonly release: () => void, readonly source?: U) {}
  /** False once the dummy has been removed. */
  get active(): boolean { return this.live; }
  /** Whether the engine accepted the cast order. A rejected order removes the dummy at once. */
  get orderAccepted(): boolean { return this.accepted; }
  /** @internal */
  initialize(accepted: boolean, cancel?: Cancel): void { this.accepted = accepted; this.cancel = cancel; }
  /** Removes the dummy now. Idempotent. */
  dispose(): void {
    if (!this.live) return;
    this.live = false;
    this.cancel?.();
    this.cancel = undefined;
    this.release();
  }
}

/** Fresh units deliberately avoid the incomplete reset contracts of naive dummy pools. */
export class DummyManager<U, P> {
  private leases: DummyLease<U>[] = [];
  private disposed = false;
  /**
   * Creates a manager with no dummies.
   * @param clock Schedules dummy removal after each cast's `duration`.
   * @param port Engine operations; see `createWarcraftDummies`.
   */
  constructor(private readonly clock: Scheduler, private readonly port: DummyPort<U, P>) {}

  /** Number of live dummies. */
  get size(): number { return this.leases.length; }

  /** True while the unit is a live dummy owned by this manager. */
  isDummy(unit: U): boolean { return this.leaseOf(unit) !== undefined; }

  /** The caster a live dummy acts for; undefined for non-dummies or dummies cast without a source. */
  sourceOf(unit: U): U | undefined { return this.leaseOf(unit)?.source; }

  /** The lease for a live dummy owned by this manager. */
  private leaseOf(unit: U): DummyLease<U> | undefined {
    for (const lease of this.leases) if (lease.unit === unit) return lease;
    return undefined;
  }

  /**
   * Creates a dummy, orders the cast and schedules its removal after `request.duration` seconds.
   * Throws on invalid input or when the port fails; the dummy is removed first.
   */
  cast(request: DummyCast<U, P>): DummyLease<U> {
    if (this.disposed) throw new Error("Dummy manager disposed");
    if (!Number.isFinite(request.duration) || request.duration <= 0) throw new Error("Invalid dummy lifetime");
    if (!Number.isFinite(request.x) || !Number.isFinite(request.y)) throw new Error("Invalid dummy position");
    if (request.facing !== undefined && !Number.isFinite(request.facing)) throw new Error("Invalid facing");
    if (request.level !== undefined && (!Number.isInteger(request.level) || request.level < 1)) throw new Error("Invalid ability level");
    if (!Number.isInteger(request.rawcode) || !Number.isInteger(request.ability) || request.order.length === 0) throw new Error("Invalid dummy ability/order");
    if (request.target !== undefined && request.point !== undefined) throw new Error("Choose target OR point");
    if (request.point && (!Number.isFinite(request.point.x) || !Number.isFinite(request.point.y))) throw new Error("Invalid target point");
    const unit = this.port.create(request);
    if (unit === undefined) throw new Error("Dummy creation failed");
    const lease = new DummyLease(unit, () => {
      const index = this.leases.indexOf(lease);
      if (index >= 0) this.leases.splice(index, 1);
      this.port.remove(unit);
    }, request.source);
    this.leases.push(lease);
    try {
      this.port.configure(unit, request);
      const accepted = this.port.order(unit, request);
      lease.initialize(accepted, accepted ? this.clock.after(request.duration, () => lease.dispose()) : undefined);
      if (!accepted) lease.dispose();
    } catch (error) { lease.dispose(); throw error; }
    return lease;
  }

  /** Removes every live dummy. Casting afterwards throws. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (const lease of this.leases.slice()) {
      try { lease.dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw errors[0];
  }
}
