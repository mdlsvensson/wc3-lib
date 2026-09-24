import assert from "node:assert/strict";
import { DamageSystem, type DamageEvent, type DamagePort, type DamageRequest } from "../damage/system.ts";
import { createWarcraftDamage } from "../damage/warcraft.ts";

type Event = DamageEvent<string>;
class NativeDamage implements DamagePort<string, undefined> {
  handlers?: { damaging: (event: Event) => void; damaged: (event: Event) => void; settled: () => void };
  starts = 0;
  stops = 0;
  calls: string[] = [];
  writes: number[] = [];
  omitPost = false;
  onDeal?: () => void;
  subscribe(handlers: NonNullable<NativeDamage["handlers"]>): () => void {
    this.starts++;
    this.handlers = handlers;
    return () => { this.stops++; this.handlers = undefined; };
  }
  setAmount(amount: number): void { this.writes.push(amount); }
  deal(request: DamageRequest<string, unknown, undefined>): boolean {
    this.calls.push(request.target);
    this.handlers?.damaging({ source: request.source, target: request.target, amount: request.amount, isAttack: false });
    this.onDeal?.();
    if (!this.omitPost) this.handlers?.damaged({ source: request.source, target: request.target, amount: request.amount / 2, isAttack: false });
    return true;
  }
  pre(target: string, amount = 10): void { this.handlers?.damaging({ source: "s", target, amount, isAttack: false }); }
  post(target: string, amount = 5): void { this.handlers?.damaged({ source: "s", target, amount, isAttack: false }); }
}

Deno.test("damage starts explicitly, applies ordered armor phases, and observes pre-health amounts", () => {
  const native = new NativeDamage();
  const system = new DamageSystem<string, string, undefined>(native);
  const order: string[] = [];
  system.beforeArmor(c => { order.push("late"); c.amount *= 2; }, 10);
  system.beforeArmor(c => { order.push("early"); c.amount += 2; }, -1);
  system.afterArmor(c => { c.amount -= 1; });
  system.observe(c => { order.push(`${c.metadata}:${c.amount}:${c.phase}`); });
  assert.equal(native.starts, 0);
  assert.throws(() => system.deal({ source: "s", target: "t", amount: 10 }));
  system.start(); system.start();
  system.deal({ source: "s", target: "t", amount: 10, metadata: "spell" });
  assert.deepEqual(native.writes, [24, 4]);
  assert.deepEqual(order, ["early", "late", "spell:4:damaged"]);
  assert.equal(native.starts, 1);
  assert.equal(system.current, undefined);
});

Deno.test("damage listener removal takes effect immediately and additions wait for next event", () => {
  const native = new NativeDamage(); const system = new DamageSystem(native); const seen: string[] = [];
  let remove = () => {};
  system.beforeArmor(() => { seen.push("first"); remove(); system.beforeArmor(() => seen.push("added")); });
  remove = system.beforeArmor(() => seen.push("removed"));
  system.start(); native.pre("a"); native.post("a"); native.pre("b");
  assert.deepEqual(seen, ["first", "first", "added"]);
});

Deno.test("native nested damage restores current and never inherits script metadata", () => {
  const native = new NativeDamage(); const system = new DamageSystem<string, string, undefined>(native);
  const seen: (string | undefined)[] = [];
  system.beforeArmor(c => {
    seen.push(c.metadata);
    if (c.target === "outer") {
      native.pre("inner"); native.post("inner");
      assert.equal(system.current, c); seen.push(system.current?.metadata);
    }
  });
  system.observe(c => seen.push(c.metadata)); system.start();
  system.deal({ source: "s", target: "outer", amount: 10, metadata: "spell" });
  native.pre("attack"); native.post("attack");
  assert.deepEqual(seen, ["spell", undefined, undefined, "spell", "spell", undefined, undefined]);
});

Deno.test("listener script damage drains FIFO after the paired event and chain limits recover", () => {
  const native = new NativeDamage(); const issues: string[] = [];
  const system = new DamageSystem(native, { maxChain: 3, onError: i => issues.push(i.code) });
  const order: string[] = [];
  system.beforeArmor(c => {
    order.push(`pre:${c.target}`);
    system.deal({ source: "s", target: `${c.target}+`, amount: 1 });
    if (c.target === "a") system.deal({ source: "s", target: "b", amount: 1 });
  });
  system.observe(c => order.push(`post:${c.target}`)); system.start();
  system.deal({ source: "s", target: "a", amount: 10 });
  assert.deepEqual(native.calls, ["a", "a+", "b"]);
  assert.deepEqual(order, ["pre:a", "post:a", "pre:a+", "post:a+", "pre:b", "post:b"]);
  assert.deepEqual(issues, ["chain-limit"]);
  assert.equal(system.current, undefined);
});

Deno.test("queue capacity rejects excess requests without losing accepted FIFO work", () => {
  const native = new NativeDamage(); const issues: string[] = [];
  const system = new DamageSystem(native, { maxQueue: 2, onError: i => issues.push(i.code) });
  const accepted: boolean[] = [];
  system.beforeArmor(c => { if (c.target === "a") for (const target of ["b", "c", "d"]) accepted.push(system.deal({ source: "s", target, amount: 1 })); });
  system.start(); system.deal({ source: "s", target: "a", amount: 1 });
  assert.deepEqual(accepted, [true, true, false]);
  assert.deepEqual(native.calls, ["a", "b", "c"]);
  assert.deepEqual(issues, ["queue-limit"]);
});

Deno.test("chain budget survives missing-pair recovery across engine turns", () => {
  const native = new NativeDamage(); const issues: string[] = [];
  const system = new DamageSystem(native, { maxChain: 2, onError: i => issues.push(i.code) });
  system.beforeArmor(c => {
    if (c.target === "spell") system.deal({ source: "s", target: "spell", amount: 1 });
  });
  native.onDeal = () => native.pre("missing");
  system.start(); system.deal({ source: "s", target: "spell", amount: 1 });
  native.handlers?.settled(); native.handlers?.settled(); native.handlers?.settled();
  assert.deepEqual(native.calls, ["spell", "spell"]);
  assert.deepEqual(issues, ["missing-damaged", "missing-damaged", "chain-limit"]);
});

Deno.test("cancelled damage remains zero through post modifiers and zero damage is observed", () => {
  const native = new NativeDamage(); const system = new DamageSystem(native); const amounts: number[] = [];
  system.beforeArmor(c => { if (c.target === "cancel") c.cancel(); });
  system.afterArmor(c => { if (c.target === "cancel") c.amount = 99; });
  system.observe(c => amounts.push(c.amount)); system.start();
  native.pre("cancel"); native.post("cancel", 0); native.pre("zero", 0); native.post("zero", 0);
  assert.deepEqual(native.writes, [0, 0, 0, 0]); assert.deepEqual(amounts, [0, 0]);
});

Deno.test("missing native pairs expire without deleting a different matching frame", () => {
  const native = new NativeDamage(); const issues: string[] = []; const seen: string[] = [];
  const system = new DamageSystem(native, { onError: i => issues.push(i.code) });
  system.observe(c => seen.push(`${c.target}:${c.paired}`)); system.start();
  native.pre("outer"); native.pre("missing"); native.post("outer");
  native.handlers?.settled(); native.post("missing");
  assert.deepEqual(seen, ["outer:true", "missing:false"]);
  assert.deepEqual(issues, ["missing-damaged", "unpaired-damaged"]);
});

Deno.test("script calls with missing post events release metadata before the next native event", () => {
  const native = new NativeDamage(); const issues: string[] = []; const seen: (string | undefined)[] = [];
  const system = new DamageSystem<string, string, undefined>(native, { onError: i => issues.push(i.code) });
  system.beforeArmor(c => seen.push(c.metadata)); system.start(); native.omitPost = true;
  system.deal({ source: "s", target: "same", amount: 0, metadata: "cancelled-spell" });
  native.pre("same"); native.post("same");
  assert.deepEqual(seen, ["cancelled-spell", undefined]); assert.deepEqual(issues, ["missing-damaged"]);
});

Deno.test("listener failures restore context and later damage still works", () => {
  const native = new NativeDamage(); const issues: string[] = []; const seen: number[] = [];
  const system = new DamageSystem(native, { onError: i => issues.push(i.code) });
  system.beforeArmor(c => { if (c.target === "bad") throw new Error("bad listener"); c.amount += 1; });
  system.observe(c => seen.push(c.amount)); system.start();
  system.deal({ source: "s", target: "bad", amount: 4 }); system.deal({ source: "s", target: "good", amount: 6 });
  assert.equal(system.current, undefined); assert.deepEqual(issues, ["listener-error"]); assert.deepEqual(seen, [2, 3]);
});

Deno.test("same source-target native nesting claims script metadata only once", () => {
  const native = new NativeDamage(); const system = new DamageSystem<string, string, undefined>(native);
  let nested = false; const seen: (string | undefined)[] = [];
  system.beforeArmor(c => {
    if (!nested) { nested = true; native.pre(c.target); native.post(c.target); }
  });
  system.observe(c => seen.push(c.metadata)); system.start();
  system.deal({ source: "s", target: "same", amount: 1, metadata: "spell" });
  assert.deepEqual(seen, [undefined, "spell"]);
});

Deno.test("observation registration during pre armor waits until the next damage event", () => {
  const native = new NativeDamage(); const system = new DamageSystem(native); const seen: string[] = [];
  system.beforeArmor(() => { system.observe(c => seen.push(c.target)); }); system.start();
  system.deal({ source: "s", target: "first", amount: 1 });
  system.deal({ source: "s", target: "second", amount: 1 });
  assert.deepEqual(seen, ["second"]);
});

Deno.test("default throwing error path clears dispatch and queue state for subsequent calls", () => {
  const native = new NativeDamage(); const system = new DamageSystem(native); const seen: string[] = [];
  const off = system.beforeArmor(() => { throw new Error("listener"); }); system.start();
  assert.throws(() => system.deal({ source: "s", target: "bad", amount: 1 }));
  assert.equal(system.current, undefined); off(); system.observe(c => seen.push(c.target));
  system.deal({ source: "s", target: "good", amount: 1 }); assert.deepEqual(seen, ["good"]);
});

Deno.test("observations cannot rewrite the amount seen by later observers through current", () => {
  const native = new NativeDamage(); const system = new DamageSystem(native); const seen: number[] = [];
  system.observe(() => { system.current!.amount = 99; });
  system.observe(c => seen.push(c.amount)); system.start();
  system.deal({ source: "s", target: "t", amount: 10 });
  assert.deepEqual(seen, [5]); assert.deepEqual(native.writes, [10, 5]);
});

Deno.test("disposing inside a listener cancels remaining listeners, queued work and native resources", () => {
  const native = new NativeDamage(); const system = new DamageSystem(native); let called = false;
  system.beforeArmor(() => { system.deal({ source: "s", target: "never", amount: 1 }); system.dispose(); });
  system.beforeArmor(() => { called = true; }); system.start();
  system.deal({ source: "s", target: "outer", amount: 1 }); system.dispose();
  assert.equal(called, false); assert.deepEqual(native.calls, ["outer"]); assert.equal(native.stops, 1);
  assert.equal(system.current, undefined); assert.throws(() => system.start());
});

Deno.test("Warcraft adapter allocates on start, routes native events, defaults deal flags and destroys handles", () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = new Map<string, unknown>();
  const triggers: { action?: () => void; registrations: unknown[][] }[] = [];
  const destroyed: unknown[] = [];
  const timer = {};
  let scheduled: (() => void) | undefined;
  let event = { source: {}, target: {}, amount: 0, isAttack: false };
  const calls: unknown[][] = [];
  const detailWrites: unknown[] = [];
  let amount = 0;
  const natives: Record<string, unknown> = {
    bj_MAX_PLAYER_SLOTS: 24, EVENT_PLAYER_UNIT_DAMAGING: "pre", EVENT_PLAYER_UNIT_DAMAGED: "post",
    ATTACK_TYPE_NORMAL: "normal", DAMAGE_TYPE_NORMAL: "damage", WEAPON_TYPE_WHOKNOWS: "weapon",
    CreateTrigger: () => { const trigger = { registrations: [] as unknown[][] }; triggers.push(trigger); return trigger; },
    CreateTimer: () => timer,
    DestroyTrigger: (handle: unknown) => destroyed.push(handle),
    DestroyTimer: (handle: unknown) => destroyed.push(handle),
    PauseTimer: () => { scheduled = undefined; },
    Player: (id: number) => id,
    TriggerRegisterPlayerUnitEvent: (trigger: typeof triggers[number], ...args: unknown[]) => { trigger.registrations.push(args); return {}; },
    TriggerAddAction: (trigger: typeof triggers[number], action: () => void) => { trigger.action = action; return {}; },
    TimerStart: (handle: unknown, delay: number, repeat: boolean, callback: () => void) => {
      assert.equal(handle, timer); assert.equal(delay, 0); assert.equal(repeat, false); scheduled = callback;
    },
    GetEventDamageSource: () => event.source,
    BlzGetEventDamageTarget: () => event.target,
    GetEventDamage: () => event.amount,
    BlzGetEventIsAttack: () => event.isAttack,
    BlzSetEventDamage: (value: number) => { amount = value; },
    BlzGetEventAttackType: () => "atk", BlzGetEventDamageType: () => "dmg", BlzGetEventWeaponType: () => "wpn",
    BlzSetEventAttackType: (value: unknown) => detailWrites.push(value),
    BlzSetEventDamageType: (value: unknown) => detailWrites.push(value),
    BlzSetEventWeaponType: (value: unknown) => detailWrites.push(value),
    UnitDamageTarget: (...args: unknown[]) => {
      calls.push(args);
      event = { source: args[0] as object, target: args[1] as object, amount: args[2] as number, isAttack: args[3] as boolean };
      triggers[0].action!();
      event.amount = amount / 2;
      triggers[1].action!();
      return true;
    },
  };
  for (const key of Object.keys(natives)) { previous.set(key, globals[key]); globals[key] = natives[key]; }
  try {
    const issues: string[] = [];
    const system = createWarcraftDamage<string>({ onError: issue => issues.push(issue.code) });
    const seen: (string | undefined)[] = [];
    system.beforeArmor(c => { c.amount *= 2; c.detail.damageType = "universal" as never; });
    system.afterArmor(c => { c.amount -= 1; });
    system.observe(c => seen.push(c.metadata));
    assert.equal(triggers.length, 0);
    system.start();
    assert.equal(triggers.length, 2);
    assert.equal(triggers[0].registrations.length, 24);
    assert.deepEqual(triggers[0].registrations[23], [23, "pre"]);
    assert.deepEqual(triggers[1].registrations[0], [0, "post"]);
    const source = {} as never; const target = {} as never;
    system.deal({ source, target, amount: 10, metadata: "spell" });
    assert.deepEqual(calls[0], [source, target, 10, false, false, "normal", "damage", "weapon"]);
    assert.equal(amount, 9); assert.deepEqual(seen, ["spell"]);
    // Detail is read from the event and written back once, after beforeArmor, inside DAMAGING.
    assert.deepEqual(detailWrites, ["atk", "universal", "wpn"]);
    event = { source, target, amount: 10, isAttack: false }; triggers[0].action!();
    scheduled!();
    assert.deepEqual(issues, ["missing-damaged"]);
    system.dispose(); system.dispose();
    assert.deepEqual(destroyed, [triggers[0], triggers[1], timer]);
    assert.equal(scheduled, undefined);
    globals.TriggerRegisterPlayerUnitEvent = () => undefined;
    const failed = createWarcraftDamage();
    assert.throws(() => failed.start());
    assert.deepEqual(destroyed.slice(3), [triggers[2], triggers[3], timer]);
    failed.dispose();
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete globals[key]; else globals[key] = value; }
  }
});
