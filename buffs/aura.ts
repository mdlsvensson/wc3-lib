/**
 * `Aura`, which keeps an aura buff on whatever targets a query returns. Each emitter
 * owns its instances, so two auras of the same kind never remove each other's buff.
 *
 * @example
 * ```ts
 * import { Aura } from "@mdlsvensson/wc3-lib/buffs/aura";
 * import { BuffStore } from "@mdlsvensson/wc3-lib/buffs/buffs";
 * import { Scheduler } from "@mdlsvensson/wc3-lib/core/scheduler";
 *
 * const clock = new Scheduler();
 * const buffs = new BuffStore<unit>(clock);
 * declare const emitter: unit;
 * declare function alliesNear(center: unit): unit[]; // sorted by handle id
 * const aura = new Aura(buffs, { id: "devotion", kind: "aura" }, emitter, () => alliesNear(emitter))
 *   .start(clock);
 * ```
 *
 * @module
 */

import { BuffStore, type BuffDefinition, type BuffInstance } from "./buffs.ts";
import type { Cancel, Scheduler } from "../core/scheduler.ts";

/**
 * Each emitter owns its instances; range/team/visibility rules belong to query.
 * query() must return the same order on every client (sort by handle ID).
 */
export class Aura<T> {
  private members = new Map<T, BuffInstance<T>>();
  private disposed = false;
  private stopTimer?: Cancel;
  /**
   * Creates a stopped aura; call `start()` or `update()`.
   * @param store The store the aura's buff instances live in.
   * @param definition A definition with `kind: "aura"`.
   * @param source The emitter; each emitter's contributions are independent.
   * @param query Returns the targets that should currently carry the aura, in a deterministic order.
   */
  constructor(
    private readonly store: BuffStore<T>,
    private readonly definition: BuffDefinition<T>,
    private readonly source: unknown,
    private readonly query: () => readonly T[],
  ) {
    if (definition.kind !== "aura") throw new Error("Aura requires an aura buff definition");
  }

  /** Reconcile now and then every interval seconds. dispose() stops the timer. */
  start(clock: Scheduler, interval = 0.5): this {
    if (this.disposed) throw new Error("Aura disposed");
    this.stopTimer?.();
    this.update();
    this.stopTimer = clock.every(interval, () => this.update());
    return this;
  }

  /** Reconciles once: removes the buff from targets `query` no longer returns and applies it to new ones. */
  update(): void {
    if (this.disposed) return;
    const wanted = new Set(this.query());
    for (const [target, buff] of this.members) {
      if (!wanted.has(target)) {
        this.members.delete(target);
        buff.remove("source-lost");
      }
    }
    for (const target of wanted) {
      if (this.disposed) break;
      if (this.members.get(target)?.active) continue;
      const buff = this.store.apply(target, this.definition, this.source);
      if (this.disposed) buff.remove("source-lost");
      else this.members.set(target, buff);
    }
  }

  /** Stops the timer and removes every buff this aura applied. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTimer?.();
    this.stopTimer = undefined;
    const members = this.members;
    this.members = new Map();
    const errors: unknown[] = [];
    for (const [, buff] of members) {
      try { buff.remove("source-lost"); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw errors[0];
  }
}
