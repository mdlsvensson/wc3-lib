import assert from "node:assert/strict";
import { Scheduler } from "../core/scheduler.ts";
import { DummyManager, type DummyPort } from "../dummy/dummy.ts";

function fixture() {
  let next = 0;
  const live = new Set<number>();
  const removed: number[] = [];
  const port: DummyPort<number, number> = {
    create: () => { live.add(++next); return next; },
    remove: unit => { live.delete(unit); removed.push(unit); },
    configure: () => {},
    order: () => true,
  };
  const clock = new Scheduler(1);
  return { port, clock, live, removed, manager: new DummyManager(clock, port) };
}

Deno.test("dummy lease stays alive through cast duration then cleans once", () => {
  const f = fixture();
  const lease = f.manager.cast({ owner: 0, rawcode: 1, x: 0, y: 0, ability: 2, order: "slow", duration: 2 });
  assert.equal(lease.orderAccepted, true);
  assert.equal(f.live.size, 1);
  f.clock.advance(); assert.equal(f.live.size, 1);
  f.clock.advance(); lease.dispose();
  assert.equal(f.live.size, 0);
  assert.deepEqual(f.removed, [1]);
  assert.equal(f.clock.pending, 0);
});

Deno.test("dummy creation rolls back partial setup and rejected orders", () => {
  const f = fixture();
  f.port.configure = () => { throw new Error("ability missing"); };
  assert.throws(() => f.manager.cast({ owner: 0, rawcode: 1, x: 0, y: 0, ability: 2, order: "slow", duration: 2 }));
  assert.equal(f.live.size, 0);
  f.port.configure = () => {};
  f.port.order = () => false;
  const lease = f.manager.cast({ owner: 0, rawcode: 1, x: 0, y: 0, ability: 2, order: "slow", duration: 2 });
  assert.equal(lease.orderAccepted, false);
  assert.equal(lease.active, false);
  assert.equal(f.clock.pending, 0);
});

Deno.test("disposing manager cancels all leases and rejects new casts", () => {
  const f = fixture();
  const request = { owner: 0, rawcode: 1, x: 0, y: 0, ability: 2, order: "slow", duration: 4 };
  f.manager.cast(request); f.manager.cast(request);
  f.manager.dispose(); f.manager.dispose();
  assert.equal(f.live.size, 0);
  assert.equal(f.clock.pending, 0);
  assert.throws(() => f.manager.cast(request));
});

Deno.test("dummies attribute to their caster only while leased", () => {
  const f = fixture();
  const lease = f.manager.cast({ owner: 0, rawcode: 1, x: 0, y: 0, ability: 2, order: "slow", duration: 2, source: 99 });
  assert.equal(f.manager.isDummy(lease.unit), true);
  assert.equal(f.manager.sourceOf(lease.unit), 99);
  assert.equal(f.manager.sourceOf(12345), undefined);
  f.clock.advance(); f.clock.advance();
  assert.equal(f.manager.isDummy(lease.unit), false);
  assert.equal(f.manager.sourceOf(lease.unit), undefined);
  assert.equal(f.manager.size, 0);
});
