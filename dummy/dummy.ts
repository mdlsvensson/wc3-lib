import { Scheduler, type Cancel } from "../core/scheduler.ts";

export interface DummyCast<U, P> {
  readonly owner: P;
  readonly rawcode: number;
  readonly x: number;
  readonly y: number;
  readonly facing?: number;
  readonly ability: number;
  readonly level?: number;
  readonly order: string;
  readonly target?: U;
  readonly point?: { x: number; y: number };
  /**
   * Must include cast point, channel time AND projectile travel: removing the dummy early
   * cancels channels, and damage arriving after removal can no longer be attributed.
   */
  readonly duration: number;
  /** The real caster. Damage handlers resolve dummy → caster with DummyManager.sourceOf. */
  readonly source?: U;
}

export interface DummyPort<U, P> {
  create(request: DummyCast<U, P>): U | undefined;
  configure(unit: U, request: DummyCast<U, P>): void;
  order(unit: U, request: DummyCast<U, P>): boolean;
  remove(unit: U): void;
}

export class DummyLease<U> {
  private live = true;
  private cancel?: Cancel;
  private accepted = false;
  constructor(readonly unit: U, private readonly release: () => void, readonly source?: U) {}
  get active(): boolean { return this.live; }
  get orderAccepted(): boolean { return this.accepted; }
  /** @internal */
  initialize(accepted: boolean, cancel?: Cancel): void { this.accepted = accepted; this.cancel = cancel; }
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
  constructor(private readonly clock: Scheduler, private readonly port: DummyPort<U, P>) {}

  get size(): number { return this.leases.length; }

  /** True while the unit is a live dummy owned by this manager. */
  isDummy(unit: U): boolean { return this.leaseOf(unit) !== undefined; }

  /** The caster a live dummy acts for; undefined for non-dummies or dummies cast without a source. */
  sourceOf(unit: U): U | undefined { return this.leaseOf(unit)?.source; }

  private leaseOf(unit: U): DummyLease<U> | undefined {
    for (const lease of this.leases) if (lease.unit === unit) return lease;
    return undefined;
  }

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
