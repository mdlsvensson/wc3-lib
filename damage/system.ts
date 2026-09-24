/**
 * A snapshot taken inside the native damage callback, before changing its amount.
 * D is port-specific classification (Warcraft: attack/damage/weapon type). The port creates
 * a fresh detail object per event; listeners own it for that event and may mutate it.
 */
export interface DamageEvent<U, D = undefined> {
  readonly source: U;
  readonly target: U;
  readonly amount: number;
  readonly isAttack: boolean;
  readonly detail?: D;
}

export interface DamageRequest<U, M = unknown, O = unknown> {
  readonly source: U;
  readonly target: U;
  readonly amount: number;
  readonly metadata?: M;
  readonly options?: O;
}

export interface DamagePort<U, O = unknown, D = undefined> {
  /** Allocate only here. settled must run after the current synchronous event turn. */
  subscribe(handlers: {
    damaging: (event: DamageEvent<U, D>) => void;
    damaged: (event: DamageEvent<U, D>) => void;
    settled: () => void;
  }): () => void;
  setAmount(amount: number): void;
  /** Called once after beforeArmor listeners, still inside DAMAGING, when the event carried detail. */
  setDetail?(detail: D): void;
  deal(request: DamageRequest<U, unknown, O>): boolean;
}

export type DamagePhase = "beforeArmor" | "afterArmor" | "damaged";
export type DamageIssueCode = "listener-error" | "invalid-amount" | "queue-limit" |
  "chain-limit" | "pending-limit" | "missing-damaged" | "unpaired-damaged" | "native-rejected";

export interface DamageIssue {
  readonly code: DamageIssueCode;
  readonly error?: unknown;
}

export interface DamageSystemOptions {
  readonly maxQueue?: number;
  readonly maxChain?: number;
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
  public readonly source: U;
  public readonly target: U;
  public readonly isAttack: boolean;
  public readonly initialAmount: number;
  public readonly detail: D;
  public amount: number;
  public phase: DamagePhase = "beforeArmor";
  public beforeArmorAmount: number;
  public armorAmount: number | undefined;
  private wasCancelled = false;

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

  public get cancelled(): boolean { return this.wasCancelled; }
  public cancel(): void { this.wasCancelled = true; this.amount = 0; }
}

/** DAMAGED has fired and our modifiers ran; Warcraft need not have changed HP yet. */
export interface DamageObservation<U, M, D = undefined> {
  readonly source: U;
  readonly target: U;
  readonly isAttack: boolean;
  readonly initialAmount: number;
  readonly beforeArmorAmount: number;
  readonly armorAmount: number | undefined;
  readonly amount: number;
  readonly metadata: M | undefined;
  readonly cancelled: boolean;
  readonly paired: boolean;
  readonly detail: D;
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

  public constructor(
    private readonly port: DamagePort<U, O, D>,
    private readonly options: DamageSystemOptions = {},
  ) {
    this.maxQueue = positiveInteger(options.maxQueue ?? 128, "maxQueue");
    this.maxChain = positiveInteger(options.maxChain ?? 64, "maxChain");
    this.maxPending = positiveInteger(options.maxPending ?? 64, "maxPending");
  }

  public get current(): DamageContext<U, M, D> | undefined { return this.active; }

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

  public afterArmor(callback: (context: DamageContext<U, M, D>) => void, priority = 0): () => void {
    return this.listen(this.after, callback, priority);
  }

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

  public destroy(): void { this.dispose(); }

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

  private report(code: DamageIssueCode, error?: unknown): void {
    if (this.options.onError) this.options.onError({ code, error });
    else throw error ?? new Error(`DamageSystem: ${code}`);
  }

  private dispatch<T>(list: Listener<T>[], cutoff: number, value: () => T): void {
    for (const entry of list.slice()) {
      if (this.disposed) break;
      if (entry.id > cutoff || !entry.callback) continue;
      try { entry.callback(value()); }
      catch (error) { this.report("listener-error", error); }
    }
  }

  private withContext(context: DamageContext<U, M, D>, callback: () => void): void {
    const previous = this.active;
    this.active = context;
    this.depth++;
    try { callback(); }
    catch (error) { this.depth--; this.active = previous; throw error; }
    this.depth--;
    this.active = previous;
  }

  private normalize(context: DamageContext<U, M, D>): void {
    if (context.cancelled) context.amount = 0;
    if (!Number.isFinite(context.amount) || context.amount < 0) {
      context.amount = 0;
      this.report("invalid-amount");
    }
  }

  private removePending(frame: Pending<U, M, D>): boolean {
    const index = this.pending.indexOf(frame);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    return true;
  }

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

  private settled(): void {
    if (!this.running) return;
    const missing = this.pending.length;
    this.pending.length = 0;
    try { for (let i = 0; i < missing; i++) this.report("missing-damaged"); }
    catch (error) { this.drain(); throw error; }
    this.drain();
  }

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

  private finishInvocation(invocation: Invocation<U, M, O, D>, previous: Invocation<U, M, O, D> | undefined): void {
    this.invocation = previous;
    if (invocation.pending && this.removePending(invocation.pending)) this.report("missing-damaged");
  }

  private endDrain(): void {
    this.draining = false;
    if (this.queue.length === 0) this.chain = 0;
  }
}
