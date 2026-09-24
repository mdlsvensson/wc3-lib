/**
 * `Scope`, an ownership stack: register how to release each thing you create, then
 * dispose once. Releases run in reverse order, and one failing release never stops the rest.
 *
 * @example
 * ```ts
 * import { Scheduler } from "@mdlsvensson/wc3-lib/core/scheduler";
 * import { Scope } from "@mdlsvensson/wc3-lib/core/scope";
 *
 * const scope = new Scope(error => BJDebugMsg(`${error}`));
 * const clock = scope.add(new Scheduler());
 * scope.own(clock.every(1, () => BJDebugMsg("tick")));
 * scope.dispose(); // cancels the task, then disposes the clock
 * ```
 *
 * @module
 */

import type { Cancel } from "./scheduler.ts";

/**
 * An ownership stack: register a release for everything you create, then dispose once.
 * Releases run in reverse registration order (last created, first destroyed). A failing
 * release never stops the others; the first failure is reported or rethrown afterwards.
 */
export class Scope {
  private cleanups: Cancel[] = [];
  private disposed = false;

  /**
   * Creates an empty, active scope.
   * @param onError receives every release failure; if omitted the first one is rethrown.
   */
  constructor(private readonly onError?: (error: unknown) => void) {}

  /** True until `dispose()` has been called. */
  get active(): boolean { return !this.disposed; }

  /** Takes ownership of a release function. Owning after dispose releases immediately. */
  own(cleanup: Cancel): Cancel {
    if (this.disposed) { cleanup(); return cleanup; }
    this.cleanups.push(cleanup);
    return cleanup;
  }

  /** Convenience for anything with a dispose() method. Returns the value for chaining. */
  add<T extends { dispose(): void }>(value: T): T {
    this.own(() => value.dispose());
    return value;
  }

  /** Runs every release in reverse registration order. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const cleanups = this.cleanups;
    this.cleanups = [];
    let failure: unknown;
    let failed = false;
    for (let i = cleanups.length - 1; i >= 0; i--) {
      try { cleanups[i](); } catch (error) {
        if (this.onError) this.onError(error);
        else if (!failed) { failed = true; failure = error; }
      }
    }
    if (failed) throw failure;
  }
}
