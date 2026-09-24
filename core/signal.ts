/**
 * `Signal`, a typed event with prioritized listeners. Lower priority runs first; equal
 * priorities keep registration order.
 *
 * @example
 * ```ts
 * import { Signal } from "@mdlsvensson/wc3-lib/core/signal";
 *
 * const levelUp = new Signal<{ level: number }>();
 * const unsubscribe = levelUp.subscribe(event => BJDebugMsg(`level ${event.level}`));
 * levelUp.emit({ level: 2 });
 * unsubscribe();
 * ```
 *
 * @module
 */

import type { Cancel } from "./scheduler.ts";

interface Listener<T> { priority: number; callback?: (event: T) => void }

/** Lower priority runs first; equal priority retains registration order. */
export class Signal<T> {
  private listeners: Listener<T>[] = [];
  private disposed = false;

  /**
   * Adds a listener. Lower `priority` runs first; equal priorities keep registration order.
   * @returns A function that removes the listener.
   */
  subscribe(callback: (event: T) => void, priority = 0): Cancel {
    if (this.disposed) throw new Error("Signal disposed");
    if (!Number.isFinite(priority)) throw new Error("Invalid listener priority");
    const listener: Listener<T> = { priority, callback };
    let index = this.listeners.length;
    for (let i = 0; i < this.listeners.length; i++) {
      if (this.listeners[i].priority > priority) { index = i; break; }
    }
    this.listeners.splice(index, 0, listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      listener.callback = undefined;
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Calls every listener with `event`. Listeners added or removed during the call do not change this delivery. */
  emit(event: T): void {
    for (const listener of this.listeners.slice()) listener.callback?.(event);
  }

  /** Removes every listener. Subscribing afterwards throws. */
  dispose(): void {
    this.disposed = true;
    for (const listener of this.listeners) listener.callback = undefined;
    this.listeners = [];
  }
}
