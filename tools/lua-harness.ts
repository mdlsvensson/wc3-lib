// Lua-semantics harness for the library. Run it with `deno task test:lua` (see lua-harness.md).
// Each check targets a place where JavaScript and Lua 5.3 differ.
import { Scheduler } from "@mdlsvensson/wc3-lib/core/scheduler";
import { Scope } from "@mdlsvensson/wc3-lib/core/scope";
import { BuffStore } from "@mdlsvensson/wc3-lib/buffs/buffs";
import { MissileSystem, type CollisionTarget } from "@mdlsvensson/wc3-lib/physics/missile";
import { KnockbackSystem, knockbackVelocity } from "@mdlsvensson/wc3-lib/physics/knockback";
import { turnToward } from "@mdlsvensson/wc3-lib/physics/geometry";
import { SaveCodec } from "@mdlsvensson/wc3-lib/persistence/codec";
import { integerText, hexDecode, hexEncode } from "@mdlsvensson/wc3-lib/persistence/format";
import { SyncReceiver, chunkSaveCode } from "@mdlsvensson/wc3-lib/persistence/sync";
import { formatDuration, formatUtc, dayOfWeek, unixToUtc, utcToUnix } from "@mdlsvensson/wc3-lib/time";
import { DamageSystem, type DamageEvent } from "@mdlsvensson/wc3-lib/damage/system";

let failures = 0;
let checks = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
  if (actual !== expected) { failures++; print(`FAIL ${name}: got ${tostring(actual)} expected ${tostring(expected)}`); }
}

// 1. Missile tie-break. `a - b || c - d` never tie-breaks in Lua (0 is truthy).
{
  const hits: number[] = [];
  const t = (id: number): CollisionTarget<number> => ({ id, target: id, position: { x: 50, y: 0, z: 0 }, radius: 1 });
  const system = new MissileSystem<number>({ candidates: () => [t(9), t(4), t(7), t(2), t(8), t(1)], valid: () => true });
  system.launch({ position: { x: 0, y: 0, z: 0 }, velocity: { x: 100, y: 0, z: 0 }, radius: 1, lifetime: 10, maxHits: 6, onHit: (_, u) => { hits.push(u); } });
  system.update(1);
  check("missile tie-break", hits.join(","), "1,2,4,7,8,9");
}

// 2. Exact integers through the codec (Warcraft's Lua has 32-bit numbers: stay within 2^31-1).
{
  const codec = new SaveCodec(1, [{ version: 1, fields: [
    { key: "gold", kind: "number", min: 0, max: 2147483647, integer: true },
    { key: "ratio", kind: "number", min: 0, max: 1 },
    { key: "name", kind: "string", maxLength: 16 },
    { key: "on", kind: "boolean" },
  ] }]);
  const gold = 2147483647;
  const encoded = codec.encode({ gold, ratio: 0.25, name: "Thrall", on: true }, "Player#1");
  check("encode ok", encoded.ok, true);
  if (encoded.ok) {
    const decoded = codec.decode(encoded.value, "Player#1");
    check("decode ok", decoded.ok, true);
    if (decoded.ok) {
      check("gold exact", decoded.value.gold === gold, true);
      check("ratio", decoded.value.ratio, 0.25);
      check("name", decoded.value.name, "Thrall");
      check("bool", decoded.value.on, true);
    }
    check("binding rejects", codec.decode(encoded.value, "Other#2").ok, false);
  }
  check("integerText max", integerText(2147483647), "2147483647");
  check("integerText negative", integerText(-3 * 1.0), "-3");
  check("hex round trip", hexDecode(hexEncode("Hello; World:1")), "Hello; World:1");
}

// 3. Scheduler float rounding, heap order, buff ticks, scope order.
{
  check("ticks(0.07) at 0.01", new Scheduler(0.01).ticks(0.07), 7);
  const clock = new Scheduler(1);
  const order: string[] = [];
  clock.after(3, () => { order.push("c3"); });
  clock.every(1, () => { order.push("r1"); });
  clock.after(1, () => { order.push("a1"); });
  const cancel = clock.after(2, () => { order.push("x"); });
  clock.after(2, () => { order.push("b2"); });
  cancel();
  clock.advance(); clock.advance(); clock.advance();
  check("heap order", order.join(","), "r1,a1,r1,b2,c3,r1");
  let ticks = 0;
  const store = new Scheduler(1);
  const buffs = new BuffStore<string>(store);
  buffs.apply("u", { id: "dot", kind: "active", duration: 3, interval: 1, onTick: () => { ticks++; } });
  store.advance(); store.advance(); store.advance(); store.advance();
  check("dot ticks", ticks, 3);
  check("dot gone", buffs.has("u", "dot"), false);
  const seen: string[] = [];
  const scope = new Scope();
  scope.own(() => { seen.push("a"); }); scope.own(() => { seen.push("b"); });
  scope.dispose();
  check("scope order", seen.join(","), "b,a");
}

// 4. Knockback falloff and homing maths under Lua numbers.
{
  const positions = new Map<number, { x: number; y: number }>([[1, { x: 0, y: 0 }]]);
  const system = new KnockbackSystem<number>({ valid: () => true, position: u => positions.get(u)!, move: (u, p) => { positions.set(u, p); return true; } });
  system.apply(1, { velocity: knockbackVelocity(0, 300, 1, "linear"), duration: 1, falloff: "linear" });
  system.update(0.5); system.update(0.5);
  check("knockback distance", Math.abs(positions.get(1)!.x - 300) < 0.01, true); // 32-bit floats in game
  const turned = turnToward({ x: 10, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, Math.PI / 2);
  check("turn behind", Math.abs(turned.y - 10) < 1e-9, true);
}

// 5. Time helpers (Lua % is floored, JS % truncates).
{
  check("duration", formatDuration(3725), "1:02:05");
  check("utc", formatUtc(unixToUtc(951782400)!), "2000-02-29 00:00:00");
  check("weekday negative", dayOfWeek(-86400), 3);
  check("pre-epoch round trip", utcToUnix(unixToUtc(-1234567890)!), -1234567890);
}

// 6. Sync chunking round trip.
{
  const code = hexEncode("x".repeat(400));
  const receiver = new SyncReceiver();
  receiver.expect(1, "s1", 0);
  let result: string | undefined;
  for (const packet of chunkSaveCode("s1", code)) {
    const r = receiver.accept(1, packet, 0);
    if (r.ok && r.value !== undefined) result = r.value;
  }
  check("sync round trip", result, code);
}

// 7. Damage pipeline with a mock port.
{
  let handlers: { damaging: (e: DamageEvent<string>) => void; damaged: (e: DamageEvent<string>) => void; settled: () => void } | undefined;
  const writes: number[] = [];
  const system = new DamageSystem<string, string, undefined>({
    subscribe: h => { handlers = h; return () => { handlers = undefined; }; },
    setAmount: a => { writes.push(a); },
    deal: r => {
      handlers!.damaging({ source: r.source, target: r.target, amount: r.amount, isAttack: false });
      handlers!.damaged({ source: r.source, target: r.target, amount: r.amount / 2, isAttack: false });
      return true;
    },
  });
  const tags: string[] = [];
  system.beforeArmor(c => { c.amount *= 2; });
  system.afterArmor(c => { c.amount -= 1; });
  system.observe(o => { tags.push(`${o.metadata}:${o.amount}`); });
  system.start();
  system.deal({ source: "s", target: "t", amount: 10, metadata: "fire" });
  check("damage before-armor write", writes[0], 20);
  check("damage after-armor write", writes[1], 4); // 10 / 2 is the float 5.0 in Lua; 4.0 == 4.
  check("damage observe count", tags.length, 1);
  print(`  (observation rendered in Lua as "${tags[0]}")`); // Shows "fire:4.0": floats print with .0
}

// 8. TSTL hazards found by the in-game test bed: callbacks passed by name, loop closures.
{
  let reason: string | undefined;
  const onEnd = (why: string) => { reason = why; };
  const kb = new KnockbackSystem<number>({ valid: () => true, position: () => ({ x: 0, y: 0 }), move: () => true });
  kb.apply(1, { velocity: { x: 1, y: 0 }, duration: 0.1, onEnd });
  kb.update(1);
  check("named callback gets its argument", reason, "completed"); // Needs `this: void` on onEnd.
  const captured: (() => number)[] = [];
  for (let i = 0; i < 3; i++) { const copy = i; captured.push(() => copy); }
  check("loop copy captured per iteration", captured.map(f => f()).join(","), "0,1,2");
}

print(`${checks - failures}/${checks} Lua checks passed`);
if (failures > 0) error("Lua harness failed");
