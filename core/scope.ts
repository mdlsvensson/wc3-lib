import type { Cancel } from "./scheduler.ts";

/**
 * An ownership stack: register a release for everything you create, then dispose once.
 * Releases run in reverse registration order (last created, first destroyed). A failing
 * release never stops the others; the first failure is reported or rethrown afterwards.
 */
export class Scope {
  private cleanups: Cancel[] = [];
  private disposed = false;

  /** @param onError receives every release failure; if omitted the first one is rethrown. */
  constructor(private readonly onError?: (error: unknown) => void) {}

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
