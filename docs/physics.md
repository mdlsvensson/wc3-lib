# Physics: missiles and knockback

Folder: `physics/`. Written from scratch. ALICE was read for ideas only.

## `geometry.ts`

Small maths helpers: `Point2`/`Point3` types, validation (`finite`, `positive`, `point3`, ...), `interpolate`, and **`segmentSphere(from, to, center, radius)`**. That last one answers: *"moving from A to B, how far along (0…1) do I first touch this sphere?"*. It's the heart of missile collision.

## Missiles — `missile.ts`

### Swept collision (why fast missiles don't pass through units)

A naive missile checks "is anything within 50 units of my position?" each tick. A fast missile moving 60 units per tick can jump **over** a small unit between two checks. That's called *tunnelling*.

Here, each update treats the movement as a **line segment** from the old position to the new one and tests that segment against every candidate's sphere. Nothing on the path is ever skipped, however fast the missile is.

```
tick N ●──────────────────────● tick N+1
             ( unit )    ← hit is detected at fraction 0.3 of the segment
```

### Using it

```ts
const missiles = new MissileSystem(new WarcraftMissilePort({
  maxTargetRadius: 64,                 // the biggest collision size of any eligible unit
  centerHeight: () => 60,              // absolute z of each target's hit-sphere center
  eligible: u => IsUnitEnemy(u, owner),
}));
const stop = runtime.physics(dt => missiles.update(dt));   // advance each tick

missiles.launch({
  position: { x, y, z: 60 },
  velocity: { x: 900, y: 0, z: 0 },    // units per second
  radius: 16,
  lifetime: 1.2,                       // required, seconds
  maxRange: 1000,                      // optional
  maxHits: 3,                          // >1 = piercing; each unit is hit at most once
  visual: new WarcraftMissileVisual("Abilities\\Weapons\\...\\X.mdl", { x, y, z: 60 }),
  onHit: (missile, target) => { /* deal damage, apply buff, missile.dispose() to stop early */ },
  onEnd: (missile, reason) => { /* hit-limit | expired | range | ground | cancelled | disposed | error */ },
});
```

### Arcs, homing and ground (added in the second pass)

```ts
// Artillery: gravity pulls it down; the port's groundHeight ends it on impact.
missiles.launch({ ...shot, velocity: { x: 600, y: 0, z: 700 }, acceleration: { x: 0, y: 0, z: -1400 },
  onEnd: (m, reason) => { if (reason === "ground") explodeAt(m.position); } });

// Homing: steer runs first every tick; turnToward limits how fast it can turn (radians per second × dt).
missiles.launch({ ...shot, steer: (m, dt) => {
  if (!alive(target)) { m.dispose(); return; }
  const at = m.position;
  m.velocity = turnToward(m.velocity, { x: GetUnitX(target) - at.x, y: GetUnitY(target) - at.y, z: 0 }, 4 * dt);
} });
```

For ground collision, give the port a height source: `new WarcraftMissilePort({ ..., groundHeight: (x, y) => terrain.height(x, y) })` with `const terrain = new WarcraftTerrain()` (dispose it when done). Ground is checked at the end of each tick, so a hit earlier in that same tick still counts.

Rules worth knowing:

- Hits are ordered by **distance along the path**, ties by handle ID, so every client agrees. (The first version wrote `a - b || c - d`, which silently never tie-breaks in Lua because `0` is truthy there. See `../AGENTS.md` §2.)
- If one missile's callback throws, that missile ends with `error`, the others still move, then the error is reported.
- **The system owns its port.** `missiles.dispose()` also disposes the port, which destroys its one reusable unit group.
- A unit is checked for validity again right before its hit, so if an earlier hit killed it, it's skipped.
- `onHit` may dispose the missile, dispose the whole system or kill targets. All of that is handled.
- `z` is an **absolute** height. Terrain height is opt-in (`WarcraftTerrain`), because `GetLocationZ` can differ between clients under terrain deformations (e.g. Thunder Clap ripples). On flat ground a constant works (e.g. 60).
- `maxTargetRadius` must really be the maximum. The search area uses it, so a bigger unit could be missed.
- **Missiles per side:** eligibility is set on the port, so create one `MissileSystem` per team.

**Natives (`WarcraftMissilePort`, `WarcraftMissileVisual`, `WarcraftTerrain`):** `CreateGroup` (once per port), `GroupEnumUnitsInRange`, `FirstOfGroup`, `GroupRemoveUnit`, `GroupClear`, `DestroyGroup`, `BlzGetUnitCollisionSize`, `GetUnitX`/`GetUnitY`, `GetHandleId`, `GetUnitTypeId`, `GetWidgetLife`, `IsUnitType`, `AddSpecialEffect`, `BlzSetSpecialEffectPosition`, `DestroyEffect`, `Location`/`MoveLocation`/`GetLocationZ`/`RemoveLocation`.

## Knockback — `knockback.ts`

```ts
runtime.knockback.apply(unit, {
  velocity: { x: 500, y: 0 },    // units per second
  duration: 0.3,
  falloff: "linear",             // optional: slow down to a stop instead of a constant slide
  onEnd: reason => {},           // completed | replaced | interrupted | invalid | blocked | disposed | error
});

// "Push 300 units away from the caster over 0.4 s, decelerating":
const angle = Atan2(GetUnitY(unit) - GetUnitY(caster), GetUnitX(unit) - GetUnitX(caster));
runtime.knockback.apply(unit, { velocity: knockbackVelocity(angle, 300, 0.4, "linear"), duration: 0.4, falloff: "linear" });
```

- **One knockback per unit.** A new one **replaces** the old one (the old one's `onEnd("replaced")` fires).
- Each tick it asks the port to move the unit. If the move is refused (terrain), it ends with `blocked`.
- It **never pauses the unit or changes its orders**. The unit keeps trying to walk while being pushed. Stunning it is a game decision.

### Pathing policy (`WarcraftKnockbackPort`)

You have to choose one; there's no hidden default:

| `pathing` | Behaviour |
|---|---|
| `"unrestricted"` | just `SetUnitX`/`SetUnitY`; can push units into cliffs or out of the map |
| `"terrain-point"` | samples `IsTerrainPathable(..., PATHING_TYPE_WALKABILITY)` every 32 units along the move; any unwalkable point blocks the whole move (the runtime uses this) |
| a function `(unit, from, to) => boolean` | your own rule |

⚠️ `terrain-point` does **not** check trees, buildings or other units, only terrain. Thin obstacles between sample points can be missed.

**Natives:** `SetUnitX`, `SetUnitY`, `IsTerrainPathable`, `GetUnitX`/`GetUnitY`, plus the unit-alive checks.

## Why no spatial hash / physics grid?

ALICE uses spatial cells for performance. The design is to add that **only after measuring** a real slowdown. `GroupEnumUnitsInRange` is fast in native code, and a map's own grid, if it has one, is deliberately **not** used for physics. They're separate concerns.
