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
