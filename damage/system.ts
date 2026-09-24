/**
 * The pure damage core: `DamageSystem`, `DamageContext` and the `DamagePort` a map can
 * implement. Generic over the unit type and free of natives.
 *
 * @example
 * ```ts
 * import { DamageSystem, type DamagePort } from "@mdlsvensson/wc3-lib/damage/system";
 *
 * declare const port: DamagePort<string>;
 * const damage = new DamageSystem(port, { maxChain: 16 });
 * damage.afterArmor(context => { context.amount = Math.min(context.amount, 100); });
 * damage.start();
 * ```
 *
 * @module
 */

/**
 * A snapshot taken inside the native damage callback, before changing its amount.
 * D is port-specific classification (Warcraft: attack/damage/weapon type). The port creates
 * a fresh detail object per event; listeners own it for that event and may mutate it.
 */
export interface DamageEvent<U, D = undefined> {
  /** Unit dealing the damage. */
  readonly source: U;
  /** Unit receiving the damage. */
  readonly target: U;
  /** Damage amount reported by the engine for this phase. */
  readonly amount: number;
  /** True for a basic attack, false for spells and triggered damage. */
  readonly isAttack: boolean;
  /** Port-specific classification, if the port supplies one. */
  readonly detail?: D;
}

/** Damage to deal through `DamageSystem.deal`. M is caller metadata, O port-specific options. */
export interface DamageRequest<U, M = unknown, O = unknown> {
  /** Unit credited with the damage. */
  readonly source: U;
  /** Unit to damage. */
  readonly target: U;
  /** Damage before modifiers; must be finite and nonnegative. */
  readonly amount: number;
  /** Caller data attached to the resulting hit, readable as `context.metadata` by listeners. */
  readonly metadata?: M;
  /** Port-specific options (Warcraft: attack/damage/weapon type, attack and ranged flags). */
  readonly options?: O;
}

/** Engine operations the `DamageSystem` needs. `WarcraftDamagePort` is the Warcraft one. */
export interface DamagePort<U, O = unknown, D = undefined> {
  /** Allocate only here. settled must run after the current synchronous event turn. */
  subscribe(handlers: {
    damaging: (event: DamageEvent<U, D>) => void;
    damaged: (event: DamageEvent<U, D>) => void;
    settled: () => void;
  }): () => void;
  /** Sets the amount of the event currently being handled. */
  setAmount(amount: number): void;
  /** Called once after beforeArmor listeners, still inside DAMAGING, when the event carried detail. */
  setDetail?(detail: D): void;
  /** Deals damage now. Returns whether the engine accepted it. */
  deal(request: DamageRequest<U, unknown, O>): boolean;
}

/** Where a `DamageContext` is in the pipeline: modifiers run in `beforeArmor` and `afterArmor`; observers see `damaged`. */
export type DamagePhase = "beforeArmor" | "afterArmor" | "damaged";
/** Why the system reported an issue. `missing-damaged` is normal for a hit fully blocked by spell immunity. */
export type DamageIssueCode = "listener-error" | "invalid-amount" | "queue-limit" |
  "chain-limit" | "pending-limit" | "missing-damaged" | "unpaired-damaged" | "native-rejected";

/** A problem reported to `DamageSystemOptions.onError`. */
export interface DamageIssue {
  /** What went wrong. */
  readonly code: DamageIssueCode;
  /** The thrown value, for `listener-error`. */
  readonly error?: unknown;
}

/** Limits and error handling for a `DamageSystem`. */
export interface DamageSystemOptions {
  /** Most deals that may wait in the queue. Default 128. Extra deals are rejected with `queue-limit`. */
  readonly maxQueue?: number;
  /** Most deals issued in one chain before the queue is dropped with `chain-limit`. Default 64. */
  readonly maxChain?: number;
  /** Most DAMAGING events awaiting their DAMAGED pair. Default 64. The oldest is dropped with `pending-limit`. */
  readonly maxPending?: number;
  /** If omitted, issues throw after dispatch state is restored (explicit catch-and-rethrow, never finally). */
  readonly onError?: (this: void, issue: DamageIssue) => void;
}

/**
 * Mutate amount or call cancel() in modifier phases. Amounts are nonnegative.
 * detail may be mutated in beforeArmor only (the engine applies armor between the phases);
 * it is undefined when the port supplies none.
 */
export class DamageContext<U, M, D = undefined> {
  /** Unit dealing the damage. */
  public readonly source: U;
  /** Unit receiving the damage. */
  public readonly target: U;
  /** True for a basic attack. */
  public readonly isAttack: boolean;
  /** Amount as the engine first reported it. */
  public readonly initialAmount: number;
  /** Engine classification. Mutable in `beforeArmor` only. */
  public readonly detail: D;
  /** Current amount. Set it in a modifier phase to change the damage; must stay finite and nonnegative. */
  public amount: number;
  /** Current pipeline phase. */
  public phase: DamagePhase = "beforeArmor";
  /** Amount after the `beforeArmor` listeners, before armor. */
  public beforeArmorAmount: number;
  /** Amount after armor, as reported by DAMAGED; undefined until then. */
  public armorAmount: number | undefined;
  private wasCancelled = false;

  /**
   * Created by the `DamageSystem` for each hit.
   * @param event The engine event this context starts from.
   * @param metadata Caller data from `DamageRequest.metadata`, for hits dealt through the system.
   * @param paired Whether DAMAGED was matched to a DAMAGING event.
   */
  public constructor(
    event: DamageEvent<U, D>,
    public readonly metadata: M | undefined,
    public readonly paired: boolean,
  ) {
    this.source = event.source;
    this.target = event.target;
    this.isAttack = event.isAttack;
    this.detail = event.detail as D;
    this.initialAmount = event.amount;
    this.amount = event.amount;
    this.beforeArmorAmount = event.amount;
  }

  /** Whether `cancel()` was called. */
  public get cancelled(): boolean { return this.wasCancelled; }
  /** Cancels the hit: the amount becomes 0 and stays 0 in later phases. */
  public cancel(): void { this.wasCancelled = true; this.amount = 0; }
}

/** DAMAGED has fired and our modifiers ran; Warcraft need not have changed HP yet. */
export interface DamageObservation<U, M, D = undefined> {
  /** Unit that dealt the damage. */
  readonly source: U;
  /** Unit that received the damage. */
  readonly target: U;
  /** True for a basic attack. */
  readonly isAttack: boolean;
  /** Amount as the engine first reported it. */
  readonly initialAmount: number;
  /** Amount after the `beforeArmor` listeners. */
  readonly beforeArmorAmount: number;
  /** Amount after armor, as reported by DAMAGED. */
  readonly armorAmount: number | undefined;
  /** Final amount after the `afterArmor` listeners. */
  readonly amount: number;
  /** Caller data from `DamageRequest.metadata`, for hits dealt through the system. */
  readonly metadata: M | undefined;
  /** Whether a listener cancelled the hit. */
  readonly cancelled: boolean;
  /** Whether DAMAGED was matched to a DAMAGING event. */
  readonly paired: boolean;
  /** Engine classification as the engine used it. */
  readonly detail: D;
  /** Always `"damaged"`. */
  readonly phase: "damaged";
}

interface Listener<T> {
  readonly id: number;
  readonly priority: number;
  callback: ((context: T) => void) | undefined;
}

interface Pending<U, M, D> {
  readonly context: DamageContext<U, M, D>;
  readonly cutoff: number;
}

interface Invocation<U, M, O, D> {
  readonly request: DamageRequest<U, M, O>;
  claimed: boolean;
  pending?: Pending<U, M, D>;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 1 || Math.floor(value) !== value) {
    throw new Error(`${name} must be a positive finite integer`);
  }
  return value;
}

/** Instance-local event pipeline. No native allocation occurs before start(). */
export class DamageSystem<U, M = unknown, O = unknown, D = undefined> {
  private readonly before: Listener<DamageContext<U, M, D>>[] = [];
  private readonly after: Listener<DamageContext<U, M, D>>[] = [];
  private readonly observations: Listener<DamageObservation<U, M, D>>[] = [];
  private readonly pending: Pending<U, M, D>[] = [];
  private readonly queue: DamageRequest<U, M, O>[] = [];
  private readonly maxQueue: number;
  private readonly maxChain: number;
  private readonly maxPending: number;
  private nextListener = 0;
  /** Deals issued since the queue was last empty. Persists across drains so missing native
   * events (which pause draining until settled) cannot reset the recursion budget. */
  private chain = 0;
  private depth = 0;
  private draining = false;
  private running = false;
  private disposed = false;
  private unsubscribe?: () => void;
  private active?: DamageContext<U, M, D>;
  private invocation?: Invocation<U, M, O, D>;

  /**
   * Creates a stopped system. Register listeners, then call `start()`.
   * @param port Engine operations; see `WarcraftDamagePort`.
   * @param options Queue and chain limits and the error handler.
   */
  public constructor(
    private readonly port: DamagePort<U, O, D>,
    private readonly options: DamageSystemOptions = {},
  ) {
    this.maxQueue = positiveInteger(options.maxQueue ?? 128, "maxQueue");
    this.maxChain = positiveInteger(options.maxChain ?? 64, "maxChain");
    this.maxPending = positiveInteger(options.maxPending ?? 64, "maxPending");
  }

  /** The context of the hit being handled right now, or undefined outside damage events. */
  public get current(): DamageContext<U, M, D> | undefined { return this.active; }

  /** Subscribes to the port's damage events. Idempotent while running; throws after `dispose()`. */
  public start(): void {
    if (this.disposed) throw new Error("DamageSystem is disposed");
    if (this.running) return;
    this.running = true;
    try {
      this.unsubscribe = this.port.subscribe({
        damaging: event => this.damaging(event),
        damaged: event => this.damaged(event),
        settled: () => this.settled(),
      });
    } catch (error) { this.running = false; throw error; }
  }

  /** Ascending priority; equal priorities preserve registration order. */
  public beforeArmor(callback: (context: DamageContext<U, M, D>) => void, priority = 0): () => void {
    return this.listen(this.before, callback, priority);
  }

  /**
   * Adds a modifier that runs after armor. Ascending priority; equal priorities keep registration order.
   * @returns A function that removes the listener.
   */
  public afterArmor(callback: (context: DamageContext<U, M, D>) => void, priority = 0): () => void {
    return this.listen(this.after, callback, priority);
  }

  /**
   * Adds an observer that runs once the hit's final amount is known.
   * It gets a snapshot, so changes to it do nothing. Ascending priority.
   * @returns A function that removes the listener.
   */
  public observe(callback: (event: DamageObservation<U, M, D>) => void, priority = 0): () => void {
    return this.listen(this.observations, callback, priority);
  }

  /** Returns queue acceptance, not hit success. Calls from listeners run FIFO after pairing. */
  public deal(request: DamageRequest<U, M, O>): boolean {
    if (!this.running || this.disposed) throw new Error("DamageSystem must be started before dealing damage");
    if (!Number.isFinite(request.amount) || request.amount < 0) throw new Error("Damage must be finite and nonnegative");
    if (this.queue.length >= this.maxQueue) { this.report("queue-limit"); return false; }
    // Capture primitive request fields: caller mutation cannot redirect a deferred hit.
    this.queue.push({ source: request.source, target: request.target, amount: request.amount,
      metadata: request.metadata, options: request.options });
    this.drain();
    return true;
  }

  /** Unsubscribes from the port and drops every listener and queued deal. Idempotent. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.queue.length = 0;
    this.pending.length = 0;
    this.chain = 0;
    for (const entry of this.before) entry.callback = undefined;
    for (const entry of this.after) entry.callback = undefined;
    for (const entry of this.observations) entry.callback = undefined;
    this.before.length = 0;
    this.after.length = 0;
    this.observations.length = 0;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    if (unsubscribe) unsubscribe();
  }

  /** Alias of `dispose()`. */
  public destroy(): void { this.dispose(); }

  /** Inserts a listener by priority, after existing listeners of equal priority. */
  private listen<T>(list: Listener<T>[], callback: (context: T) => void, priority: number): () => void {
    if (this.disposed) throw new Error("DamageSystem is disposed");
    if (!Number.isFinite(priority)) throw new Error("Damage priority must be finite");
    const entry: Listener<T> = { id: ++this.nextListener, priority, callback };
    let position = list.length;
    while (position > 0 && list[position - 1].priority > priority) position--;
    list.splice(position, 0, entry);
    return () => {
      entry.callback = undefined;
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
    };
  }

  /** Sends an issue to `onError`, or throws it when no handler is set. */
  private report(code: DamageIssueCode, error?: unknown): void {
    if (this.options.onError) this.options.onError({ code, error });
    else throw error ?? new Error(`DamageSystem: ${code}`);
  }

  /** Calls each live listener registered before `cutoff`. Listener errors are reported, not thrown. */
  private dispatch<T>(list: Listener<T>[], cutoff: number, value: () => T): void {
    for (const entry of list.slice()) {
      if (this.disposed) break;
      if (entry.id > cutoff || !entry.callback) continue;
      try { entry.callback(value()); }
      catch (error) { this.report("listener-error", error); }
    }
  }

  /** Makes `context` the current context while `callback` runs. */
  private withContext(context: DamageContext<U, M, D>, callback: () => void): void {
    const previous = this.active;
    this.active = context;
    this.depth++;
    try { callback(); }
    catch (error) { this.depth--; this.active = previous; throw error; }
    this.depth--;
    this.active = previous;
  }

  /** Zeroes a cancelled amount and reports a non-finite or negative one. */
  private normalize(context: DamageContext<U, M, D>): void {
    if (context.cancelled) context.amount = 0;
    if (!Number.isFinite(context.amount) || context.amount < 0) {
      context.amount = 0;
      this.report("invalid-amount");
    }
  }

  /** Removes a pending DAMAGING frame. Returns whether it was still pending. */
  private removePending(frame: Pending<U, M, D>): boolean {
    const index = this.pending.indexOf(frame);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    return true;
  }

  /** Handles DAMAGING: runs `beforeArmor` listeners and writes back amount and detail. */
  private damaging(event: DamageEvent<U, D>): void {
    if (!this.running) return;
    let metadata: M | undefined;
    const invocation = this.invocation;
    const claimed = invocation && !invocation.claimed &&
      invocation.request.source === event.source && invocation.request.target === event.target;
    if (claimed) { invocation.claimed = true; metadata = invocation.request.metadata; }
    const context = new DamageContext(event, metadata, true);
    const frame = { context, cutoff: this.nextListener };
    if (this.pending.length >= this.maxPending) {
      this.pending.shift();
      this.report("pending-limit");
    }
    this.pending.push(frame);
    if (claimed) invocation.pending = frame;
    try {
      this.withContext(context, () => {
        this.dispatch(this.before, frame.cutoff, () => context);
        this.normalize(context);
        context.beforeArmorAmount = context.amount;
        if (!this.running) return;
        this.port.setAmount(context.amount);
        if (context.detail !== undefined) this.port.setDetail?.(context.detail);
      });
    } catch (error) { this.removePending(frame); throw error; }
  }

  /** Handles DAMAGED: pairs it with its DAMAGING frame, runs `afterArmor` and observers. */
  private damaged(event: DamageEvent<U, D>): void {
    if (!this.running) return;
    let frame: Pending<U, M, D> | undefined;
    // Remove only the newest matching frame. Unrelated missing children survive until settled.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const candidate = this.pending[i];
      if (candidate.context.source === event.source && candidate.context.target === event.target &&
        candidate.context.isAttack === event.isAttack) { frame = candidate; break; }
    }
    if (frame) this.removePending(frame);
    // A paired context keeps the detail as rewritten in beforeArmor, which is what the engine used.
    const context = frame?.context ?? new DamageContext<U, M, D>(event, undefined, false);
    const cutoff = frame?.cutoff ?? this.nextListener;
    context.phase = "afterArmor";
    context.armorAmount = event.amount;
    context.amount = context.cancelled ? 0 : event.amount;
    try {
      this.withContext(context, () => {
        if (!frame) this.report("unpaired-damaged");
        this.dispatch(this.after, cutoff, () => context);
        this.normalize(context);
        if (!this.running) return;
        this.port.setAmount(context.amount);
        context.phase = "damaged";
        const observation: DamageObservation<U, M, D> = {
          source: context.source, target: context.target, isAttack: context.isAttack,
          initialAmount: context.initialAmount, beforeArmorAmount: context.beforeArmorAmount,
          armorAmount: context.armorAmount, amount: context.amount, metadata: context.metadata,
          cancelled: context.cancelled, paired: context.paired, detail: context.detail, phase: "damaged",
        };
        this.dispatch(this.observations, cutoff, () => ({ ...observation }));
      });
    } catch (error) { this.drain(); throw error; }
    this.drain();
  }

  /** Handles the end of an engine turn: frames still pending lost their DAMAGED event. */
  private settled(): void {
    if (!this.running) return;
    const missing = this.pending.length;
    this.pending.length = 0;
    try { for (let i = 0; i < missing; i++) this.report("missing-damaged"); }
    catch (error) { this.drain(); throw error; }
    this.drain();
  }

  /** Deals queued requests one at a time, when no hit is being handled. */
  private drain(): void {
    if (!this.running || this.draining || this.depth > 0 || this.pending.length > 0) return;
    this.draining = true;
    try {
      while (this.running && this.queue.length > 0 && this.pending.length === 0) {
        if (this.chain >= this.maxChain) { this.queue.length = 0; this.chain = 0; this.report("chain-limit"); break; }
        this.chain++;
        const request = this.queue.shift()!;
        const invocation: Invocation<U, M, O, D> = { request, claimed: false };
        const previous = this.invocation;
        this.invocation = invocation;
        try { if (!this.port.deal(request)) this.report("native-rejected"); }
        catch (error) { this.finishInvocation(invocation, previous); throw error; }
        this.finishInvocation(invocation, previous);
      }
    } catch (error) { this.queue.length = 0; this.endDrain(); throw error; }
    this.endDrain();
  }

  /** Restores the outer invocation and reports a deal that fired DAMAGING without DAMAGED. */
  private finishInvocation(invocation: Invocation<U, M, O, D>, previous: Invocation<U, M, O, D> | undefined): void {
    this.invocation = previous;
    if (invocation.pending && this.removePending(invocation.pending)) this.report("missing-damaged");
  }

  /** Leaves the draining state; resets the chain budget once the queue is empty. */
  private endDrain(): void {
    this.draining = false;
    if (this.queue.length === 0) this.chain = 0;
  }
}
