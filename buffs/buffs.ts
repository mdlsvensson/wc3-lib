import { Scheduler, type Cancel } from "../core/scheduler.ts";

export type BuffRemoval = "expired" | "dispelled" | "replaced" | "death" | "removed" | "source-lost" | "disposed" | "error";
/**
 * Callbacks are declared `this: void` so TypeScriptToLua calls them without a hidden self
 * argument; a named function works exactly like an inline arrow (see lib/README.md).
 */
export interface BuffDefinition<T> {
  readonly id: string;
  /** Descriptive only, except for the removeOnDeath default below. */
  readonly kind: "active" | "passive" | "aura";
  readonly stacking?: "refresh" | "replace" | "stack" | "independent";
  readonly maxStacks?: number;
  readonly duration?: number;
  /** Defaults to true, except passive buffs, which default to surviving death (hero revival). */
  readonly removeOnDeath?: boolean;
  /** Seconds between onTick calls while the buff is active; the first tick is one interval after application. */
  readonly interval?: number;
  readonly onApply?: (this: void, buff: BuffInstance<T>) => void;
  readonly onStacks?: (this: void, buff: BuffInstance<T>, previous: number) => void;
  /** Periodic effect (damage/heal over time). Throwing removes the buff with reason "error". */
  readonly onTick?: (this: void, buff: BuffInstance<T>) => void;
  readonly onRemove?: (this: void, buff: BuffInstance<T>, reason: BuffRemoval) => void;
}

interface Layer { cancel?: Cancel; expires?: number }

function removedOnDeath<T>(definition: BuffDefinition<T>): boolean {
  return definition.removeOnDeath ?? definition.kind !== "passive";
}

/** A script-owned effect; native ability buffs and UI icons are separate adapters. */
export class BuffInstance<T> {
  private layers: Layer[] = [];
  private cleanup: Cancel[] = [];
  private sharedExpiry?: Cancel;
  private sharedExpires?: number;
  private live = true;
  /** Free per-instance storage for effect state (e.g. the amount a modifier added). */
  readonly data: Record<string, unknown> = {};

  constructor(
    readonly target: T,
    readonly definition: BuffDefinition<T>,
    readonly source: unknown,
    private readonly clock: Scheduler,
    private readonly detach: () => void,
  ) {}

  get active(): boolean { return this.live; }
  get stacks(): number { return this.layers.length; }

  /** Seconds until the buff (or, for independent stacks, its last stack) expires; undefined if permanent. */
  get remaining(): number | undefined {
    if (!this.live) return 0;
    let expires = this.sharedExpires;
    for (const layer of this.layers) {
      if (layer.expires !== undefined && (expires === undefined || layer.expires > expires)) expires = layer.expires;
    }
    return expires === undefined ? undefined : Math.max(0, expires - this.clock.tick) * this.clock.stepSeconds;
  }

  /** Register inverse operations while applying a modifier, effect or subscription. */
  own(cleanup: Cancel): void {
    if (this.live) this.cleanup.push(cleanup);
    else cleanup();
  }

  /** @internal Store is responsible for validation and first-application hooks. */
  addStack(): void {
    if (!this.live) return;
    const policy = this.definition.stacking ?? "refresh";
    const previous = this.stacks;
    const cap = this.definition.maxStacks ?? 1;
    const duration = this.definition.duration;
    if (previous === 0 || ((policy === "stack" || policy === "independent") && previous < cap)) {
      const layer: Layer = {};
      this.layers.push(layer);
      if (policy === "independent" && duration !== undefined) {
        layer.expires = this.clock.tick + this.clock.ticks(duration);
        layer.cancel = this.clock.after(duration, () => {
          if (!this.live) return;
          const before = this.stacks;
          const index = this.layers.indexOf(layer);
          if (index >= 0) this.layers.splice(index, 1);
          if (this.stacks === 0) this.remove("expired");
          else this.notifyStacks(before);
        });
      }
    }
    // A capped independent application does not extend any existing stack.
    if (policy !== "independent" && duration !== undefined) {
      this.sharedExpiry?.();
      this.sharedExpires = this.clock.tick + this.clock.ticks(duration);
      this.sharedExpiry = this.clock.after(duration, () => this.remove("expired"));
    }
    if (previous > 0 && previous !== this.stacks) this.notifyStacks(previous);
  }

  /** @internal Started once by the store, before the first stack creates its expiry timer. */
  startTicking(): void {
    const { interval, onTick } = this.definition;
    if (!this.live || interval === undefined || onTick === undefined) return;
    this.own(this.clock.every(interval, () => {
      if (!this.live) return;
      try { onTick(this); }
      catch (error) { this.remove("error"); throw error; }
    }));
  }

  private notifyStacks(previous: number): void {
    try { this.definition.onStacks?.(this, previous); }
    catch (error) { this.remove("error"); throw error; }
  }

  remove(reason: BuffRemoval = "dispelled"): void {
    if (!this.live) return;
    this.live = false;
    this.detach();
    this.sharedExpiry?.();
    this.sharedExpiry = undefined;
    for (const layer of this.layers) layer.cancel?.();
    this.layers = [];
    const cleanup = this.cleanup;
    this.cleanup = [];
    const errors: unknown[] = [];
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try { cleanup[i](); } catch (error) { errors.push(error); }
    }
    try { this.definition.onRemove?.(this, reason); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw errors[0];
  }
}

/**
 * Buffs indexed by target. Iteration order is target first-seen order, then application
 * order, so bulk removal is deterministic. A target's entry is deleted when its last buff
 * goes, so the store never retains handles of units that no longer carry buffs.
 */
export class BuffStore<T> {
  private readonly byTarget = new Map<T, BuffInstance<T>[]>();
  private disposed = false;
  constructor(private readonly clock: Scheduler) {}

  apply(target: T, definition: BuffDefinition<T>, source?: unknown): BuffInstance<T> {
    if (this.disposed) throw new Error("Buff store disposed");
    if (definition.id.length === 0) throw new Error("Buff id is required");
    if (definition.duration !== undefined && (!Number.isFinite(definition.duration) || definition.duration <= 0)) {
      throw new Error("Buff duration must be positive");
    }
    if (definition.interval !== undefined && (!Number.isFinite(definition.interval) || definition.interval <= 0)) {
      throw new Error("Buff interval must be positive");
    }
    const cap = definition.maxStacks ?? 1;
    if (!Number.isInteger(cap) || cap < 1) throw new Error("Invalid stack cap");
    const existing = this.find(target, definition.id, source);
    if (existing) {
      if (existing.definition !== definition) throw new Error("Use the same buff definition for a given id/source");
      if (definition.stacking !== "replace") { existing.addStack(); return existing; }
      existing.remove("replaced");
      // Removal hooks may have applied a replacement; never create two entries for one key.
      const replacement = this.find(target, definition.id, source);
      if (replacement) return replacement;
      if (this.disposed) throw new Error("Buff store disposed during replacement");
    }
    const buff: BuffInstance<T> = new BuffInstance(target, definition, source, this.clock, () => this.detach(buff));
    const list = this.byTarget.get(target);
    if (list) list.push(buff);
    else this.byTarget.set(target, [buff]);
    // Ticking starts before the expiry timer exists, so on a shared deadline the tick runs first:
    // duration 3 / interval 1 ticks three times, the last on the expiry tick.
    try { buff.startTicking(); buff.addStack(); definition.onApply?.(buff); }
    catch (error) { buff.remove("error"); throw error; }
    return buff;
  }

  /** Buffs on the target in application order. Returns a copy. */
  list(target: T): readonly BuffInstance<T>[] { return this.byTarget.get(target)?.slice() ?? []; }

  /** The buff with this id and source; with source omitted, the first with this id from any source. */
  get(target: T, id: string, source?: unknown): BuffInstance<T> | undefined {
    const list = this.byTarget.get(target);
    if (!list) return undefined;
    for (const buff of list) {
      if (buff.definition.id === id && (source === undefined || buff.source === source)) return buff;
    }
    return undefined;
  }

  has(target: T, id: string, source?: unknown): boolean { return this.get(target, id, source) !== undefined; }

  /** Stacks of this id summed over every source. */
  stacks(target: T, id: string): number {
    let total = 0;
    for (const buff of this.byTarget.get(target) ?? []) if (buff.definition.id === id) total += buff.stacks;
    return total;
  }

  clearTarget(target: T, reason: BuffRemoval = "removed"): void {
    const list = this.byTarget.get(target);
    if (!list) return;
    this.removeAll(list.filter(b => reason !== "death" || removedOnDeath(b.definition)), reason);
  }

  clearSource(source: unknown): void { this.removeWhere(b => b.source === source, "source-lost"); }

  /** Poll engine handle validity; explicit death events can call clearTarget immediately. */
  prune(isPresent: (target: T) => boolean, isAlive: (target: T) => boolean): void {
    const errors: unknown[] = [];
    for (const target of [...this.byTarget.keys()]) {
      try {
        if (!isPresent(target)) this.clearTarget(target, "removed");
        else if (!isAlive(target)) this.clearTarget(target, "death");
      } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw errors[0];
  }

  dispose(): void {
    this.disposed = true;
    this.removeWhere(() => true, "disposed");
  }

  private find(target: T, id: string, source: unknown): BuffInstance<T> | undefined {
    for (const buff of this.byTarget.get(target) ?? []) {
      if (buff.definition.id === id && buff.source === source) return buff;
    }
    return undefined;
  }

  private detach(buff: BuffInstance<T>): void {
    const list = this.byTarget.get(buff.target);
    if (!list) return;
    const index = list.indexOf(buff);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.byTarget.delete(buff.target);
  }

  private removeWhere(predicate: (buff: BuffInstance<T>) => boolean, reason: BuffRemoval): void {
    const matched: BuffInstance<T>[] = [];
    for (const [, list] of this.byTarget) for (const buff of list) if (predicate(buff)) matched.push(buff);
    this.removeAll(matched, reason);
  }

  private removeAll(buffs: readonly BuffInstance<T>[], reason: BuffRemoval): void {
    const errors: unknown[] = [];
    for (const buff of buffs) {
      try { buff.remove(reason); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw errors[0];
  }
}
