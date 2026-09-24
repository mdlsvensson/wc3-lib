import assert from "node:assert/strict";
import { Scheduler } from "../core/scheduler.ts";
import { BuffStore, type BuffDefinition } from "../buffs/buffs.ts";
import { Aura } from "../buffs/aura.ts";

Deno.test("independent stacks expire separately and respect the cap", () => {
  const clock = new Scheduler(1);
  const buffs = new BuffStore<string>(clock);
  const changes: number[] = [];
  const definition: BuffDefinition<string> = {
    id: "poison", kind: "active", stacking: "independent", maxStacks: 2, duration: 2,
    onStacks: buff => changes.push(buff.stacks),
  };
  const buff = buffs.apply("unit", definition, "caster");
  clock.advance();
  assert.equal(buffs.apply("unit", definition, "caster"), buff);
  buffs.apply("unit", definition, "caster");
  assert.equal(buff.stacks, 2);
  clock.advance(); assert.equal(buff.stacks, 1);
  clock.advance(); assert.equal(buff.active, false);
  assert.deepEqual(changes, [2, 1]);
  assert.equal(clock.pending, 0);
});

Deno.test("refresh extends a buff and removal releases owned effects exactly once", () => {
  const clock = new Scheduler(1);
  const buffs = new BuffStore<string>(clock);
  let cleaned = 0;
  const definition: BuffDefinition<string> = {
    id: "haste", kind: "active", duration: 2,
    onApply: buff => buff.own(() => cleaned++),
  };
  const buff = buffs.apply("u", definition);
  clock.advance(); buffs.apply("u", definition); clock.advance();
  assert.equal(buff.active, true);
  clock.advance(); buff.remove();
  assert.equal(cleaned, 1);
  assert.equal(buffs.list("u").length, 0);
});

Deno.test("aura emitters own independent contributions and recover after dispel", () => {
  const clock = new Scheduler(1);
  const buffs = new BuffStore<string>(clock);
  const definition: BuffDefinition<string> = { id: "armor", kind: "aura" };
  let targets = ["u"];
  const a = new Aura(buffs, definition, "a", () => targets);
  const b = new Aura(buffs, definition, "b", () => ["u"]);
  a.update(); b.update(); assert.equal(buffs.list("u").length, 2);
  a.dispose(); assert.equal(buffs.list("u").length, 1);
  buffs.clearTarget("u", "dispelled"); b.update(); assert.equal(buffs.list("u").length, 1);
  targets = []; b.dispose(); assert.equal(buffs.list("u").length, 0);
});

Deno.test("buff callbacks can remove themselves and passive death policy is explicit", () => {
  const clock = new Scheduler(1);
  const buffs = new BuffStore<string>(clock);
  const ephemeral = buffs.apply("u", {
    id: "cancel", kind: "active", duration: 2, onApply: buff => buff.remove(),
  });
  assert.equal(ephemeral.active, false);
  assert.equal(clock.pending, 0);
  buffs.apply("u", { id: "talent", kind: "passive", removeOnDeath: false });
  buffs.apply("u", { id: "poison", kind: "active", duration: 5 });
  buffs.clearTarget("u", "death"); assert.equal(buffs.list("u").length, 1);
  buffs.clearTarget("u", "removed"); assert.equal(buffs.list("u").length, 0);
  buffs.dispose(); assert.throws(() => buffs.apply("u", { id: "x", kind: "passive" }));
});

Deno.test("buff cleanup finishes even when one owned effect throws", () => {
  const clock = new Scheduler(1);
  const buffs = new BuffStore<string>(clock);
  let cleanup = 0;
  const buff = buffs.apply("u", {
    id: "cleanup", kind: "active", duration: 1,
    onApply: b => { b.own(() => cleanup++); b.own(() => { throw new Error("broken effect"); }); },
  });
  assert.throws(() => buff.remove());
  assert.equal(cleanup, 1);
  assert.equal(buff.active, false);
  assert.equal(clock.pending, 0);
});

Deno.test("periodic buffs tick on the clock, report remaining time and stop ticking on removal", () => {
  const clock = new Scheduler(1);
  const buffs = new BuffStore<string>(clock);
  let ticks = 0;
  const dot: BuffDefinition<string> = { id: "dot", kind: "active", duration: 3, interval: 1, onTick: () => ticks++ };
  const buff = buffs.apply("u", dot);
  assert.equal(buff.remaining, 3);
  clock.advance(); clock.advance();
  assert.equal(ticks, 2);
  assert.equal(buff.remaining, 1);
  clock.advance();
  assert.equal(buff.active, false);
  clock.advance();
  assert.equal(ticks, 3);
  assert.equal(clock.pending, 0);
  assert.equal(buffs.apply("u", { id: "permanent", kind: "passive" }).remaining, undefined);
  assert.throws(() => buffs.apply("u", { id: "bad", kind: "active", interval: 0, onTick: () => {} }));
});

Deno.test("a throwing tick removes its buff with reason error", () => {
  const errors: unknown[] = [];
  const clock = new Scheduler(1, e => errors.push(e));
  const buffs = new BuffStore<string>(clock);
  const reasons: string[] = [];
  const buff = buffs.apply("u", { id: "x", kind: "active", interval: 1, onTick: () => { throw new Error("tick"); },
    onRemove: (_, reason) => reasons.push(reason) });
  clock.advance();
  assert.equal(buff.active, false);
  assert.deepEqual(reasons, ["error"]);
  assert.equal(errors.length, 1);
});

Deno.test("lookup helpers, passive death default and per-target index cleanup", () => {
  const clock = new Scheduler(1);
  const buffs = new BuffStore<string>(clock);
  const sunder: BuffDefinition<string> = { id: "sunder", kind: "active", stacking: "stack", maxStacks: 5 };
  buffs.apply("u", sunder, "a"); buffs.apply("u", sunder, "a"); buffs.apply("u", sunder, "b");
  assert.equal(buffs.stacks("u", "sunder"), 3);
  assert.equal(buffs.has("u", "sunder", "b"), true);
  assert.equal(buffs.get("u", "sunder")?.source, "a");
  assert.equal(buffs.has("v", "sunder"), false);
  buffs.apply("u", { id: "talent", kind: "passive" });
  buffs.clearTarget("u", "death");
  assert.deepEqual(buffs.list("u").map(b => b.definition.id), ["talent"]);
  const probed: string[] = [];
  buffs.clearTarget("u", "removed");
  buffs.prune(t => { probed.push(t); return true; }, () => true);
  assert.deepEqual(probed, []); // No buffs left, so the target key itself was released.
});

Deno.test("aura start reconciles immediately and on its interval; dispose stops the timer", () => {
  const clock = new Scheduler(1);
  const buffs = new BuffStore<string>(clock);
  let targets = ["u"];
  const aura = new Aura(buffs, { id: "a", kind: "aura" }, "src", () => targets).start(clock, 2);
  assert.equal(buffs.has("u", "a"), true);
  targets = ["v"];
  clock.advance(); assert.equal(buffs.has("v", "a"), false);
  clock.advance(); assert.equal(buffs.has("v", "a"), true);
  assert.equal(buffs.has("u", "a"), false);
  aura.dispose();
  assert.equal(clock.pending, 0);
  assert.equal(buffs.has("v", "a"), false);
});
