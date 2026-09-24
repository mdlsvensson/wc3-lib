import assert from "node:assert/strict";
import { Scheduler } from "../core/scheduler.ts";
import { Signal } from "../core/signal.ts";
import { Scope } from "../core/scope.ts";

Deno.test("scheduler cancels later callbacks and defers additions during dispatch", () => {
  const clock = new Scheduler(0.25);
  const calls: string[] = [];
  let cancel = () => {};
  clock.after(0, () => {
    calls.push("first"); cancel();
    clock.after(0, () => calls.push("new"));
  });
  cancel = clock.after(0, () => calls.push("cancelled"));
  clock.advance();
  assert.deepEqual(calls, ["first"]);
  clock.advance();
  assert.deepEqual(calls, ["first", "new"]);
});

Deno.test("scheduler rounds deadlines up, recurs and releases cancelled work", () => {
  const clock = new Scheduler(0.25);
  let count = 0;
  const cancel = clock.every(0.3, () => count++);
  clock.advance(); assert.equal(count, 0);
  clock.advance(); assert.equal(count, 1);
  clock.advance(); clock.advance(); assert.equal(count, 2);
  cancel(); clock.advance(); clock.advance(); assert.equal(count, 2);
  assert.equal(clock.pending, 0);
  clock.dispose(); clock.dispose();
  assert.throws(() => clock.after(1, () => {}));
  assert.throws(() => new Scheduler(0));
});

Deno.test("scheduler isolates errors and rejects reentrant advances", () => {
  const errors: unknown[] = [];
  const clock = new Scheduler(1, e => errors.push(e));
  let later = 0;
  clock.every(1, () => { clock.advance(); });
  clock.after(1, () => later++);
  clock.advance(); clock.advance();
  assert.equal(errors.length, 1);
  assert.equal(later, 1);
  assert.equal(clock.pending, 0);
});

Deno.test("signal snapshots additions and honors removals with priority ordering", () => {
  const signal = new Signal<number>();
  const seen: number[] = [];
  let off = () => {};
  signal.subscribe(v => { seen.push(v); off(); signal.subscribe(x => seen.push(x + 10)); }, -1);
  off = signal.subscribe(v => seen.push(v + 1));
  signal.emit(1);
  assert.deepEqual(seen, [1]);
  signal.emit(2);
  assert.deepEqual(seen, [1, 2, 12]);
  signal.dispose(); signal.emit(3);
  assert.deepEqual(seen, [1, 2, 12]);
});

Deno.test("scheduler tick rounding absorbs float error in non power-of-two steps", () => {
  const clock = new Scheduler(0.01);
  assert.equal(0.07 / 0.01, 7.000000000000001); // Plain Math.ceil would schedule 8 ticks.
  assert.equal(clock.ticks(0.07), 7);
  assert.equal(clock.ticks(0.071), 8);
  assert.equal(clock.ticks(0), 1);
  assert.throws(() => clock.ticks(-1));
});

Deno.test("scheduler heap runs due tasks by deadline then creation order and removes mid-heap tasks", () => {
  const clock = new Scheduler(1);
  const order: string[] = [];
  clock.after(3, () => order.push("c3"));
  clock.every(1, () => order.push("r1"));
  clock.after(1, () => order.push("a1"));
  const cancel = clock.after(2, () => order.push("cancelled"));
  clock.after(2, () => order.push("b2"));
  for (let i = 0; i < 20; i++) clock.after(5 + (i % 3), () => {});
  cancel();
  clock.advance(); clock.advance(); clock.advance();
  assert.deepEqual(order, ["r1", "a1", "r1", "b2", "c3", "r1"]);
  assert.equal(clock.pending, 21);
});

Deno.test("scope releases in reverse order, continues after failures and releases late owners at once", () => {
  const seen: string[] = [];
  const errors: unknown[] = [];
  const scope = new Scope(error => errors.push(error));
  scope.own(() => seen.push("first"));
  scope.own(() => { throw new Error("boom"); });
  scope.add({ dispose: () => seen.push("second") });
  scope.dispose(); scope.dispose();
  assert.deepEqual(seen, ["second", "first"]);
  assert.equal(errors.length, 1);
  scope.own(() => seen.push("late"));
  assert.deepEqual(seen, ["second", "first", "late"]);
  const strict = new Scope();
  strict.own(() => { throw new Error("rethrown"); });
  assert.throws(() => strict.dispose(), /rethrown/);
});
