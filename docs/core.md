# Core: Scheduler, Scope, Signal, Warcraft clock

Folder: `core/` (`@mdlsvensson/wc3-lib/core` gives the scheduler and the Warcraft clock; `Scope` and `Signal` are separate, opt-in imports: `@mdlsvensson/wc3-lib/core/scope`, `@mdlsvensson/wc3-lib/core/signal`). Everything else is built on these files.

## `scheduler.ts` — `Scheduler`

A **manually stepped clock**. It doesn't run by itself; something calls `advance()` once per tick.

```ts
const clock = new Scheduler(1 / 32, error => print(error)); // step, error reporter
const cancel = clock.after(2, () => print("2 seconds later"));
const stop   = clock.every(0.5, () => print("twice a second"));
cancel(); stop();                     // both safe to call any time, any number of times
clock.tick; clock.elapsed;            // current tick number, seconds since start
```

How it works:

- Each task stores the tick it's `due` on. Seconds → ticks rounds **up**, with a minimum of 1 tick, so `after(0, fn)` means "next tick", never "right now". `clock.ticks(seconds)` tells you the count. A tiny tolerance absorbs float noise: `0.07 / 0.01` is `7.000000000000001` in floating point and must still be 7 ticks, not 8.
- Tasks live in a **binary heap** (a priority queue) ordered by due tick, then creation order. A tick only touches the tasks that are actually due, so 1,000 buff timers cost nothing until they expire.
- Tasks due on the same tick run in the order they were created. Tasks created during a tick run on a later tick. Repeating tasks get their next due tick **before** their callback runs.
- If a callback throws, that task is removed, the others still run, and the errors go to `onError` **after** the tick finishes, so the clock is always in a consistent state.
- `advance()` inside a callback throws, which prevents accidental recursion.
- `dispose()` drops all tasks.

Pattern notes: this is a "discrete event simulation" clock. It's pure (no natives), which is why every time-based test is exact.

## `warcraft-clock.ts` — `startWarcraftClock(clock)`

The only thing that connects the Scheduler to real time:

```ts
const stop = startWarcraftClock(clock);  // CreateTimer + TimerStart(step, periodic)
stop();                                   // PauseTimer + DestroyTimer, idempotent
```

**Natives:** `CreateTimer`, `TimerStart`, `PauseTimer`, `DestroyTimer`.

## `scope.ts` — `Scope`

The "keep a list of cleanups, undo them newest-first" pattern, as a class:

```ts
const scope = new Scope(error => print(error));   // optional error reporter
scope.own(clock.every(1, tick));                  // any () => void
const missiles = scope.add(new MissileSystem(port)); // anything with dispose()
scope.dispose();   // runs everything in reverse; one failure doesn't stop the rest
```

Owning something after `dispose()` releases it immediately, so late registrations can't leak. Use it for any feature that creates several things.

## `signal.ts` — `Signal<T>`

A small typed event emitter:

```ts
const roundStarted = new Signal<{ round: number }>();
const off = roundStarted.subscribe(e => print(`round ${e.round}`), /* priority */ 0);
roundStarted.emit({ round: 1 });
off();
```

Lower priority runs first; equal priority runs in subscribe order. Emitting loops over a snapshot, and listeners removed mid-emit are skipped. It isn't used by the systems yet; it's meant for game events ("round started", "unit bought") so game modules don't import each other directly.

## Why a scheduler instead of w3ts `Timer`?

- One real timer for the whole game, not hundreds.
- Everything shares one timeline (a buff expiring and a missile moving in the same tick happen in a known order).
- Tests control time exactly.
- Cancellation is always a function, and it's always safe.
