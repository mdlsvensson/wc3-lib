import assert from "node:assert/strict";
import { MissileSystem, type CollisionTarget, type MissileEnd } from "../physics/missile/system.ts";
import { KnockbackSystem, knockbackVelocity } from "../physics/knockback/system.ts";
import { turnToward } from "../physics/geometry.ts";
import { WarcraftKnockbackPort } from "../physics/knockback/warcraft.ts";
import { WarcraftMissilePort, WarcraftMissileVisual } from "../physics/missile/warcraft.ts";

const p = (x = 0, y = 0, z = 0) => ({ x, y, z });
const target = (id: number, x: number, y = 0, z = 0): CollisionTarget<number> =>
  ({ id, target: id, position: p(x, y, z), radius: 1 });
const shot = { position: p(), velocity: p(100), radius: 1, lifetime: 10 };

Deno.test("swept missiles hit fast crossings in distance then stable id order", () => {
  const hits: number[] = [];
  const system = new MissileSystem<number>({ candidates: () => [target(3, 80), target(2, 30), target(1, 30)], valid: () => true });
  const missile = system.launch({ ...shot, maxHits: 3, onHit: (_, unit) => hits.push(unit) });
  system.update(1);
  assert.deepEqual(hits, [1, 2, 3]);
  assert.equal(missile.active, false);
  assert.equal(missile.position.x, 78);
});

Deno.test("sphere collision uses height and deduplicates repeated targets", () => {
  const hits: number[] = [];
  const system = new MissileSystem<number>({ candidates: () => [target(1, 0), target(1, 0), target(2, 0, 0, 5)], valid: () => true });
  system.launch({ ...shot, velocity: p(), maxHits: 10, onHit: (_, unit) => hits.push(unit) });
  system.update(1);
  system.update(1);
  assert.deepEqual(hits, [1]);
});

Deno.test("hit callback disposal stops dispatch and releases visual once", () => {
  let disposed = 0;
  const hits: number[] = [];
  const system = new MissileSystem<number>({ candidates: () => [target(1, 10), target(2, 20)], valid: () => true });
  const missile = system.launch({ ...shot, maxHits: 10, visual: { move: () => {}, dispose: () => disposed++ }, onHit: (m, unit) => { hits.push(unit); m.dispose(); } });
  system.update(1);
  missile.dispose();
  system.dispose();
  assert.deepEqual(hits, [1]);
  assert.equal(disposed, 1);
});

Deno.test("lifetime and range clip sweeps before collision and expire stationary missiles", () => {
  const hits: number[] = [];
  const system = new MissileSystem<number>({ candidates: () => [target(1, 40)], valid: () => true });
  const lifetime = system.launch({ ...shot, lifetime: 0.25, onHit: (_, unit) => hits.push(unit) });
  const range = system.launch({ ...shot, maxRange: 20, onHit: (_, unit) => hits.push(unit) });
  const stationary = system.launch({ ...shot, velocity: p(), lifetime: 0.1 });
  system.update(1);
  assert.deepEqual(hits, []);
  assert.equal(lifetime.position.x, 25);
  assert.equal(range.position.x, 20);
  assert.equal(stationary.active, false);
  assert.equal(system.size, 0);
});

Deno.test("callback additions wait for next update and removed targets are rechecked", () => {
  const live = new Set([1, 2]);
  const hits: number[] = [];
  const system = new MissileSystem<number>({ candidates: () => [target(1, 10), target(2, 20)], valid: (unit) => live.has(unit) });
  let child: ReturnType<typeof system.launch> | undefined;
  system.launch({ ...shot, maxHits: 3, onHit: (_, unit) => { hits.push(unit); live.delete(2); child = system.launch({ ...shot }); } });
  system.update(1);
  assert.deepEqual(hits, [1]);
  assert.equal(child?.position.x, 0);
  system.update(0.1);
  assert.equal(child?.active, false);
});

Deno.test("callback errors cancel affected missile and restore update state", () => {
  let disposed = 0;
  const system = new MissileSystem<number>({ candidates: () => [target(1, 10)], valid: () => true });
  const missile = system.launch({ ...shot, visual: { move: () => {}, dispose: () => disposed++ }, onHit: () => { throw new Error("hit failed"); } });
  assert.throws(() => system.update(1), /hit failed/);
  assert.equal(missile.active, false);
  assert.equal(disposed, 1);
  const next = system.launch({ ...shot });
  system.update(1);
  assert.equal(next.active, false);
});

Deno.test("invalid physics values fail before visual ownership transfers", () => {
  const system = new MissileSystem<number>({ candidates: () => [], valid: () => true });
  assert.throws(() => system.launch({ ...shot, lifetime: 0 }));
  assert.throws(() => system.launch({ ...shot, velocity: p(NaN) }));
  assert.throws(() => system.launch({ ...shot, maxHits: 0 }));
  assert.throws(() => system.update(-1));
  system.dispose();
  assert.throws(() => system.launch(shot));
});

function knockbackFixture() {
  const positions = new Map<number, { x: number; y: number }>([[1, p()], [2, p()]]);
  const system = new KnockbackSystem<number>({
    valid: (unit) => positions.has(unit),
    position: (unit) => positions.get(unit)!,
    move: (unit, position) => { positions.set(unit, position); return true; },
  });
  return { system, positions };
}

Deno.test("replacement knockback exclusively owns movement and old handles cannot cancel it", () => {
  const { system, positions } = knockbackFixture();
  const reasons: string[] = [];
  const first = system.apply(1, { velocity: { x: 10, y: 0 }, duration: 1, onEnd: (reason) => reasons.push(reason) });
  const second = system.apply(1, { velocity: { x: 0, y: 20 }, duration: 0.5, onEnd: (reason) => reasons.push(reason) });
  first.dispose();
  system.update(1);
  assert.deepEqual(positions.get(1), { x: 0, y: 10 });
  assert.deepEqual(reasons, ["replaced", "completed"]);
  assert.equal(second.active, false);
  assert.equal(system.size, 0);
});

Deno.test("knockback releases invalid targets and blocked movement without pausing units", () => {
  const { system, positions } = knockbackFixture();
  const reasons: string[] = [];
  system.apply(1, { velocity: { x: 10, y: 0 }, duration: 1, onEnd: (reason) => reasons.push(reason) });
  positions.delete(1);
  system.update(0.1);
  const blocked = new KnockbackSystem<number>({ valid: () => true, position: () => p(), move: () => false });
  blocked.apply(1, { velocity: p(10), duration: 1, onEnd: (reason) => reasons.push(reason) });
  blocked.update(0.1);
  assert.deepEqual(reasons, ["invalid", "blocked"]);
  assert.equal(system.size, 0);
  assert.equal(blocked.size, 0);
});

Deno.test("replacement callbacks cannot steal ownership from newest knockback", () => {
  const { system, positions } = knockbackFixture();
  let nested: ReturnType<typeof system.apply> | undefined;
  system.apply(1, { velocity: p(10), duration: 1, onEnd: () => { nested = system.apply(1, { velocity: { x: 0, y: 30 }, duration: 1 }); } });
  const outer = system.apply(1, { velocity: p(20), duration: 1 });
  system.update(0.5);
  assert.equal(outer.active, false);
  assert.equal(nested?.active, true);
  assert.deepEqual(positions.get(1), { x: 0, y: 15 });
  system.dispose();
  assert.equal(nested?.active, false);
});

Deno.test("Warcraft missile enumeration covers segment and radii, reuses one owned group and clears it on failure", () => {
  let created = 0;
  let cleared = 0;
  let destroyed = 0;
  let radius = 0;
  let queue: number[] = [];
  Object.assign(globalThis, {
    CreateGroup: () => { created++; return {}; }, DestroyGroup: () => destroyed++, GroupClear: () => cleared++,
    GroupEnumUnitsInRange: (_: unknown, x: number, y: number, r: number) => { assert.equal(x, 50); assert.equal(y, 0); radius = r; queue = [1]; },
    FirstOfGroup: () => queue[0], GroupRemoveUnit: () => queue.shift(),
    GetHandleId: (unit: number) => unit, GetUnitX: () => 50, GetUnitY: () => 0,
    GetUnitTypeId: () => 1, GetWidgetLife: () => 100,
    IsUnitType: () => false, UNIT_TYPE_DEAD: "dead", BlzGetUnitCollisionSize: () => 8,
  });
  const port = new WarcraftMissilePort({ maxTargetRadius: 16, centerHeight: () => 32 });
  assert.deepEqual(port.candidates(p(), p(100), 2), [{ id: 1, target: 1, position: p(50, 0, 32), radius: 8 }]);
  assert.equal(radius, 68);
  port.candidates(p(), p(100), 2);
  assert.deepEqual([created, cleared, destroyed], [1, 2, 0]);
  port.dispose(); port.dispose();
  assert.equal(destroyed, 1);
  assert.throws(() => port.candidates(p(), p(100), 2), /disposed/);
  const broken = new WarcraftMissilePort({ maxTargetRadius: 16, centerHeight: () => { throw new Error("height"); } });
  assert.throws(() => broken.candidates(p(), p(100), 2), /height/);
  assert.equal(cleared, 3);
  // The failed query released its busy flag, so the next query reuses the shared group again.
  assert.throws(() => broken.candidates(p(), p(100), 2), /height/);
  assert.equal(created, 2);
});

Deno.test("Warcraft visual owns effect through repeated disposal and ignores later movement", () => {
  let destroyed = 0;
  const moved: number[][] = [];
  Object.assign(globalThis, {
    AddSpecialEffect: () => ({}), DestroyEffect: () => destroyed++,
    BlzSetSpecialEffectPosition: (_: unknown, x: number, y: number, z: number) => moved.push([x, y, z]),
  });
  const visual = new WarcraftMissileVisual("model.mdx", p(1, 2, 3));
  visual.move(p(4, 5, 6));
  visual.dispose();
  visual.dispose();
  visual.move(p(7, 8, 9));
  assert.equal(destroyed, 1);
  assert.deepEqual(moved, [[1, 2, 3], [4, 5, 6]]);
});

Deno.test("Warcraft terrain point policy samples travel and rejects it before moving", () => {
  const samples: number[] = [];
  const moved: number[] = [];
  Object.assign(globalThis, {
    PATHING_TYPE_WALKABILITY: "walkability", GetUnitX: () => 0, GetUnitY: () => 0,
    IsTerrainPathable: (x: number) => { samples.push(x); return x === 10; },
    SetUnitX: (_: unknown, x: number) => moved.push(x), SetUnitY: (_: unknown, y: number) => moved.push(y),
  });
  const port = new WarcraftKnockbackPort({ pathing: "terrain-point", sampleStep: 10 });
  assert.equal(port.move(1 as never, { x: 30, y: 0 }), false);
  assert.deepEqual(samples, [10]);
  assert.deepEqual(moved, []);
  const unrestricted = new WarcraftKnockbackPort({ pathing: "unrestricted" });
  assert.equal(unrestricted.move(1 as never, { x: 30, y: 0 }), true);
  assert.deepEqual(moved, [30, 0]);
});

Deno.test("derived speed overflow is rejected before a projectile can produce invalid travel", () => {
  const system = new MissileSystem<number>({ candidates: () => [], valid: () => true });
  assert.throws(() => system.launch({ ...shot, velocity: p(1e200) }));
  assert.equal(system.size, 0);
});

Deno.test("native allocation failures are explicit and do not use invalid handles", () => {
  Object.assign(globalThis, { CreateGroup: () => undefined, AddSpecialEffect: () => undefined });
  const port = new WarcraftMissilePort({ maxTargetRadius: 10, centerHeight: () => 0 });
  assert.throws(() => port.candidates(p(), p(100), 2), /group/);
  assert.throws(() => new WarcraftMissileVisual("model.mdx", p()), /effect/);
});

Deno.test("system disposal continues cleanup when an owned visual throws", () => {
  let disposed = 0;
  const system = new MissileSystem<number>({ candidates: () => [], valid: () => true });
  system.launch({ ...shot, visual: { move: () => {}, dispose: () => { disposed++; throw new Error("cleanup"); } } });
  system.launch({ ...shot, visual: { move: () => {}, dispose: () => { disposed++; } } });
  assert.throws(() => system.dispose(), /cleanup/);
  system.dispose();
  assert.equal(disposed, 2);
  assert.equal(system.size, 0);
});

Deno.test("terrain point sampling rejects unbounded work before native queries", () => {
  Object.assign(globalThis, {
    GetUnitX: () => 0, GetUnitY: () => 0,
    IsTerrainPathable: () => { throw new Error("must reject before sampling"); },
  });
  const port = new WarcraftKnockbackPort({ pathing: "terrain-point", sampleStep: 1 });
  assert.equal(port.move(1 as never, { x: 1e30, y: 0 }), false); // Representable in 32-bit floats, still far too many samples.
});

Deno.test("sweeps include tangent contacts and reject targets behind travel", () => {
  const hits: number[] = [];
  const system = new MissileSystem<number>({ candidates: () => [target(1, 50, 2), target(2, -10)], valid: () => true });
  const missile = system.launch({ ...shot, onHit: (_, unit) => hits.push(unit) });
  system.update(1);
  assert.deepEqual(hits, [1]);
  assert.deepEqual(missile.position, p(50));
});

Deno.test("knockback callback failure releases all ownership during system shutdown", () => {
  const { system } = knockbackFixture();
  let released = 0;
  system.apply(1, { velocity: p(10), duration: 1, onEnd: () => { released++; throw new Error("end failed"); } });
  system.apply(2, { velocity: p(10), duration: 1, onEnd: () => { released++; } });
  assert.throws(() => system.dispose(), /end failed/);
  system.dispose();
  assert.equal(system.size, 0);
  assert.equal(released, 2);
});

Deno.test("simultaneous contacts order by id with an explicit comparator (Lua has no falsy 0)", () => {
  const hits: number[] = [];
  const system = new MissileSystem<number>({ candidates: () => [target(9, 50), target(4, 50), target(7, 50)], valid: () => true });
  system.launch({ ...shot, maxHits: 3, onHit: (_, unit) => hits.push(unit) });
  system.update(1);
  assert.deepEqual(hits, [4, 7, 9]);
});

Deno.test("missiles report exactly one end reason", () => {
  const ends: MissileEnd[] = [];
  const onEnd = (_: unknown, reason: MissileEnd) => ends.push(reason);
  const system = new MissileSystem<number>({ candidates: () => [target(1, 50)], valid: () => true });
  system.launch({ ...shot, onEnd });                                    // hit-limit
  system.launch({ ...shot, velocity: p(0, 100), lifetime: 0.5, onEnd }); // expired
  system.launch({ ...shot, velocity: p(0, 100), maxRange: 20, onEnd });  // range
  system.launch({ ...shot, velocity: p(0, 100), onEnd }).dispose();      // cancelled
  system.update(1);
  system.launch({ ...shot, velocity: p(0, 100), onEnd });
  system.dispose();                                                     // disposed
  assert.deepEqual(ends, ["cancelled", "hit-limit", "expired", "range", "disposed"]);
});

Deno.test("gravity arcs a missile into the ground and the system owns its port", () => {
  let reason: MissileEnd | undefined;
  let disposed = 0;
  const system = new MissileSystem<number>({ candidates: () => [], valid: () => true, groundHeight: () => 0, dispose: () => disposed++ });
  const missile = system.launch({ position: p(0, 0, 0), velocity: p(100, 0, 100), acceleration: p(0, 0, -200),
    radius: 1, lifetime: 10, onEnd: (_, r) => { reason = r; } });
  for (let i = 0; i < 20 && missile.active; i++) system.update(0.1);
  assert.equal(reason, "ground");
  assert.equal(missile.position.z, 0);
  assert.ok(missile.position.x > 90 && missile.position.x < 110, "landed at " + missile.position.x);
  system.dispose(); system.dispose();
  assert.equal(disposed, 1);
});

Deno.test("steering with turnToward homes on a target without exceeding the turn rate", () => {
  const goal = p(0, 500);
  const system = new MissileSystem<number>({ candidates: () => [target(1, 0, 500)], valid: () => true });
  let hit = false;
  const missile = system.launch({ ...shot, velocity: p(300), lifetime: 20, onHit: () => { hit = true; },
    steer: (m, dt) => {
      const at = m.position;
      m.velocity = turnToward(m.velocity, { x: goal.x - at.x, y: goal.y - at.y, z: goal.z - at.z }, Math.PI * dt);
    } });
  for (let i = 0; i < 400 && missile.active; i++) system.update(1 / 32);
  assert.equal(hit, true);
  const turned = turnToward(p(10), p(0, 1), Math.PI / 4);
  assert.ok(Math.abs(Math.hypot(turned.x, turned.y) - 10) < 1e-9);
  assert.ok(Math.abs(Math.atan2(turned.y, turned.x) - Math.PI / 4) < 1e-9);
  const reversed = turnToward(p(10), p(-1), Math.PI / 2); // Directly behind: deterministic left turn.
  assert.ok(Math.abs(reversed.x) < 1e-9 && Math.abs(reversed.y - 10) < 1e-9);
});

Deno.test("one throwing missile ends with error while the others still advance", () => {
  const ends: MissileEnd[] = [];
  const system = new MissileSystem<number>({ candidates: () => [], valid: () => true });
  system.launch({ ...shot, steer: () => { throw new Error("bad steer"); }, onEnd: (_, r) => ends.push(r) });
  const healthy = system.launch({ ...shot });
  assert.throws(() => system.update(0.5), /bad steer/);
  assert.deepEqual(ends, ["error"]);
  assert.deepEqual(healthy.position, p(50));
});

Deno.test("linear knockback falloff covers the requested distance and decelerates", () => {
  const { system, positions } = knockbackFixture();
  const velocity = knockbackVelocity(0, 300, 1, "linear");
  assert.ok(Math.abs(velocity.x - 600) < 1e-9);
  system.apply(1, { velocity, duration: 1, falloff: "linear" });
  system.update(0.5);
  const half = positions.get(1)!.x;
  system.update(0.5);
  assert.ok(Math.abs(positions.get(1)!.x - 300) < 1e-9);
  assert.ok(Math.abs(half - 225) < 1e-9, "first half moved " + half); // Three quarters of the distance.
  assert.equal(system.size, 0);
});
