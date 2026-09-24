/**
 * A manually stepped, deterministic clock. Delays round up to whole ticks, and tasks due
 * on the same tick run in creation order. Pure: no natives. Drive it with `advance()`,
 * or with `startWarcraftClock` in a map.
 *
 * @example
 * ```ts
 * import { Scheduler } from "@mdlsvensson/wc3-lib/core/scheduler";
 *
 * const clock = new Scheduler(0.5);
 * clock.after(1, () => BJDebugMsg("one second"));
 * clock.advance(); clock.advance(); // prints on the second tick
 * ```
 *
 * @module
 */

/** Cancels a scheduled task or releases a resource. Idempotent: calling it again does nothing. */
export type Cancel = () => void;

interface Task {
  due: number;
  /** Creation sequence. Equal deadlines run in creation order, including repeating tasks. */
  readonly order: number;
  readonly interval: number;
  callback?: () => void;
  /** Position in the heap, or -1 once removed. */
  index: number;
}

/**
 * Absorbs float error in seconds/step. Warcraft's Lua uses 32-bit floats (verified by -selftest), where
 * 0.07 / 0.01 lands slightly above 7; 1e-4 of a tick is far above that error and far below any real delay.
 */
const TICK_EPSILON = 1e-4;

function earlier(a: Task, b: Task): boolean {
  return a.due < b.due || (a.due === b.due && a.order < b.order);
}

/**
 * Manually stepped deterministic clock. Seconds are rounded UP to whole ticks (minimum 1).
 * Tasks live in a binary min-heap keyed by (due tick, creation order), so a tick costs
 * O(k log n) for the k tasks that are due rather than a scan over every pending task.
 */
export class Scheduler {
  private heap: Task[] = [];
  private currentTick = 0;
  private sequence = 0;
  private advancing = false;
  private disposed = false;

  /**
   * Creates a stopped clock. Drive it with `advance()` or `startWarcraftClock`.
   * @param stepSeconds Seconds per tick; must be finite and positive. Default 1/32, matching a 0.03125 s Warcraft timer.
   * @param onError Receives errors thrown by tasks, after the tick finishes. Default rethrows.
   */
  constructor(
    readonly stepSeconds = 1 / 32,
    private readonly onError: (error: unknown) => void = error => { throw error; },
  ) {
    if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) throw new Error("Invalid clock step");
  }

  /** Ticks advanced so far. */
  get tick(): number { return this.currentTick; }
  /** Simulated seconds so far (`tick * stepSeconds`). */
  get elapsed(): number { return this.currentTick * this.stepSeconds; }
  /** Number of scheduled tasks that have not run or been cancelled. */
  get pending(): number { return this.heap.length; }

  /** Whole ticks a delay occupies under this clock's rounding policy. */
  ticks(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid delay");
    return Math.max(1, Math.ceil(seconds / this.stepSeconds - TICK_EPSILON));
  }

  /**
   * Runs `callback` once, `seconds` from now (rounded up to whole ticks, minimum one).
   * @returns A function that cancels the task.
   */
  after(seconds: number, callback: () => void): Cancel { return this.schedule(seconds, callback, false); }
  /**
   * Runs `callback` every `seconds` (rounded up to whole ticks), starting one interval from now.
   * A repeating task that throws is cancelled.
   * @returns A function that cancels the task.
   */
  every(seconds: number, callback: () => void): Cancel { return this.schedule(seconds, callback, true); }

  /** Validates the delay and pushes a task onto the heap. */
  private schedule(seconds: number, callback: () => void, repeat: boolean): Cancel {
    if (this.disposed) throw new Error("Clock disposed");
    if (repeat && seconds === 0) throw new Error("Invalid delay");
    const ticks = this.ticks(seconds);
    const task: Task = { due: this.currentTick + ticks, order: this.sequence++, interval: repeat ? ticks : 0, callback, index: -1 };
    this.push(task);
    return () => this.remove(task);
  }

  /**
   * Advances one tick and runs every task now due, in (due tick, creation order).
   * Throws if called from inside a task. Task errors go to `onError` after the tick.
   */
  advance(): void {
    if (this.disposed) return;
    if (this.advancing) throw new Error("Cannot advance clock during a tick");
    this.advancing = true;
    this.currentTick++;
    const errors: unknown[] = [];
    // No `finally` anywhere in src/: TSTL 1.31 either swallows the error or skips the block.
    try {
      // Tasks scheduled during this tick are due at least one tick later, so they cannot run now.
      while (this.heap.length > 0 && this.heap[0].due <= this.currentTick) {
        const task = this.heap[0];
        const callback = task.callback!;
        if (task.interval === 0) this.remove(task);
        else { task.due = this.currentTick + task.interval; this.sift(task.index); }
        // A throwing task is cancelled (repeating ones included) and reported after the tick.
        try { callback(); }
        catch (error) { this.remove(task); errors.push(error); }
      }
    } catch (error) { this.advancing = false; throw error; }
    this.advancing = false;
    // Restore clock invariants before invoking potentially throwing user reporters.
    for (const error of errors) this.onError(error);
  }

  /** Cancels every pending task. Scheduling afterwards throws; advancing does nothing. */
  dispose(): void {
    this.disposed = true;
    for (const task of this.heap) { task.callback = undefined; task.index = -1; }
    this.heap = [];
  }

  /** Adds a task to the heap. */
  private push(task: Task): void {
    task.index = this.heap.length;
    this.heap.push(task);
    this.up(task.index);
  }

  /** Idempotent: cancelling twice, or after the task ran, does nothing. */
  private remove(task: Task): void {
    task.callback = undefined;
    const index = task.index;
    if (index < 0) return;
    task.index = -1;
    const last = this.heap.pop()!;
    if (last === task) return;
    this.heap[index] = last;
    last.index = index;
    this.sift(index);
  }

  /** Restores heap order for the task at `index` after its due tick changed. */
  private sift(index: number): void {
    if (!this.up(index)) this.down(index);
  }

  /** Moves the task at `index` toward the root. Returns whether it moved. */
  private up(index: number): boolean {
    const heap = this.heap;
    const task = heap[index];
    let moved = false;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = heap[parentIndex];
      if (!earlier(task, parent)) break;
      heap[index] = parent; parent.index = index;
      index = parentIndex; moved = true;
    }
    heap[index] = task; task.index = index;
    return moved;
  }

  /** Moves the task at `index` toward the leaves. */
  private down(index: number): void {
    const heap = this.heap;
    const task = heap[index];
    const size = heap.length;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= size) break;
      const right = left + 1;
      const child = right < size && earlier(heap[right], heap[left]) ? right : left;
      if (!earlier(heap[child], task)) break;
      heap[index] = heap[child]; heap[index].index = index;
      index = child;
    }
    heap[index] = task; task.index = index;
  }
}
