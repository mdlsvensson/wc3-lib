# wc3-lib — opt-in Warcraft III systems for TypeScript maps

A scheduler, script buffs and auras, dummy casters, a damage pipeline, missiles and knockback, save codes and time helpers, for Warcraft III maps written in TypeScript and compiled to Lua with TypeScriptToLua ([w3ts-framework](https://github.com/mdlsvensson/w3ts-framework)). Published to JSR as `@mdlsvensson/wc3-lib`.

**Opt-in by design.** A map pays only for what it imports: a module nothing imports adds 0 bytes to `war3map.lua`, and importing a module runs no natives. A system starts only when your code creates it (`start()`, `create…()`, a constructor). The library never auto-starts anything.

```ts
import { KnockbackSystem } from "@mdlsvensson/wc3-lib/physics/knockback";
import { Scheduler } from "@mdlsvensson/wc3-lib/core/scheduler";
```

Inside the library, modules import each other relatively, with `.ts` extensions. Nothing here contains map rawcodes, coordinates or game rules; those come in as parameters.

## Entry points

One entry point per feature. Each pulls in only what that feature needs (enforced by `tests/opt-in.test.ts`), and every file is also importable on its own, so a map can use a pure core (`…/damage/system`, `…/physics/missile/system`) with its own port.

| Import `@mdlsvensson/wc3-lib/…` | Gives you | Bundles |
|---|---|---|
| `core` | `Scheduler`, `startWarcraftClock` | scheduler, warcraft-clock |
| `core/scope`, `core/signal` | `Scope`, `Signal` (opt-in) | that file |
| `buffs` | `BuffStore`, `trackWarcraftBuffTargets` | buffs, warcraft-buffs |
| `buffs/aura` | `Aura` (uses a `BuffStore` you pass in) | aura |
| `dummy` | `DummyManager`, `createWarcraftDummies` | dummy, warcraft-dummy |
| `damage` | `createWarcraftDamage`, `DamageSystem`, `isLethal` | system, warcraft |
| `physics/knockback` | `KnockbackSystem`, `knockbackVelocity`, `WarcraftKnockbackPort` | geometry, knockback system + adapter |
| `physics/missile` | `MissileSystem`, `WarcraftMissilePort`, `WarcraftMissileVisual` | geometry, missile system + adapter |
| `physics/geometry`, `physics/warcraft-terrain` | `turnToward` and vector helpers; `WarcraftTerrain` | that file |
| `persistence/codec`, `persistence/local-file`, `persistence/sync` | `SaveCodec`; `PreloadLocalStore`; `WarcraftSyncTransport` | format + that file |
| `persistence/format` | `integerText`, `hexEncode`, … | format |
| `time`, `time/warcraft` | calendar and formatting; `readWarcraftUtc` | time (+ warcraft) |

There is no top-level barrel and no barrel that mixes optional features (no `physics`, no `persistence`).

The TypeScript sources are what you consume: the map's TypeScriptToLua build compiles them, so only the files reachable from your imports end up in the map. How w3ts-framework brings them into a map is documented with the framework.

## Shared rules

- **Importing never allocates.** Timers, triggers, groups and effects are created only by an explicit `start()`, `create…()` or constructor that says so.
- **One owner per handle.** Every service has an idempotent `dispose()` that releases what it owns. Use `Scope` to own several things at once.
- **Pure core plus a thin Warcraft adapter.** Logic is generic over the unit type and tested in Deno with mocks (`tests/`). The `warcraft*.ts` files are the only ones that call natives.
- **Deterministic.** Stable ordering everywhere (listener priority, creation order, handle-ID tie breaks). No `GetLocalPlayer` branches that change shared state.
- **Lua-safe.** No `JSON`, `RegExp` or `Date` at runtime.

## This code runs as Lua 5.3, not JavaScript

**Warcraft's Lua specifically (verified in game):** numbers are **32-bit** (integers wrap past 2,147,483,647, floats are exact only to 16,777,216), **NaN == NaN is true** (so NaN can't be detected; never produce it), and there is **no `os.time`** (use `readWarcraftUtc()` from `time/warcraft.ts`, which reads `os.date`). Engines clamp stats, so a buff must undo the delta it actually applied.

Deno tests run the library as JavaScript, so they cannot catch these. Two real bugs of this kind were found in review:

- `0` and `""` are **truthy** in Lua. Never put a number or string on the left of `||`/`&&` or under `!`. `a - b || c - d` never evaluates `c - d`. Use `??` or explicit comparisons. `deno task lint` flags the common forms (`wcraft-rules/lua-truthiness`).
- `sort` is `table.sort`, which is **unstable**. Comparators return explicit `-1/0/1` and tie-break on a unique key.
- `String(n)` and template literals use Lua `tostring`: 14 significant digits, and integer-valued floats print as `5.0`. Use `integerText` (persistence/format) for text that must be exact.
- `%` is floored in Lua and truncated in JS. They agree only for non-negative operands.
- Compare characters with `charCodeAt`, not `<`/`>=` on strings (Lua uses the C locale).
- **Never write `finally`.** TypeScriptToLua 1.31 miscompiles it: `try/finally` swallows the error, and `try/catch/finally` skips the `finally` when the catch rethrows. Write `try { … } catch (e) { cleanup(); throw e; } cleanup();`. Lint: `wcraft-rules/lua-no-finally`.
- **Closures must not capture a `for (let i …)` variable.** TSTL emits one shared `local i`, so every closure sees the last value. Copy it (`const index = i;`) or use `for…of`/`forEach`. Lint: `wcraft-rules/lua-loop-closure`.
- **Callback properties are declared `this: void`** (`onEnd?: (this: void, reason: …) => void`). Without it TSTL passes a hidden `self`, and a named function passed to an optional callback silently receives shifted arguments. Do the same for any new callback property. For the same reason, declare callbacks in your own interfaces as properties, not method signatures.

`testbed/main.ts` is a map entry point that exercises every module in game through chat commands (`-help`). See [`tools/testbed.md`](tools/testbed.md).

## Modules

| Module | Entry points | What it gives you |
|---|---|---|
| `core/` | `Scheduler`, `Scope`, `Signal`, `startWarcraftClock` | A fixed-step (1/32 s) heap-scheduled tick clock; `after`/`every` return a cancel function. `Scope` releases owned things in reverse. |
| `buffs/` | `BuffStore`, `Aura`, `trackWarcraftBuffTargets` | Script buffs: active, passive or aura; refresh/replace/stack/independent stacking; periodic `onTick`; `remaining`; `has`/`get`/`stacks`. Source-keyed, so two auras never cancel each other. |
| `dummy/` | `DummyManager`, `createWarcraftDummies` | Leased, fresh dummy casters with timed cleanup and caster attribution (`sourceOf`). Caller supplies rawcode, ability and order. |
| `damage/` | `createWarcraftDamage`, `DamageSystem`, `isLethal` | beforeArmor → afterArmor → observe pipeline, attack/damage/weapon type read and rewrite, script metadata, bounded queued script damage. |
| `physics/` (`knockback/`, `missile/`) | `MissileSystem`, `KnockbackSystem`, `turnToward`, `knockbackVelocity`, `WarcraftMissilePort`, `WarcraftMissileVisual`, `WarcraftTerrain`, `WarcraftKnockbackPort` | Swept-sphere missiles (no tunnelling) with piercing, gravity arcs, homing and ground impact; knockback with optional deceleration and an explicit pathing policy. |
| `persistence/` | `SaveCodec`, `PreloadLocalStore`, `WarcraftSyncTransport` | Versioned, checksummed, optionally player-bound save codes; chunked local files; synced multiplayer import. |
| `time/` | `utcToUnix`, `unixToUtc`, `formatDuration`, `formatUtc`, `dayOfWeek`, `SimulationTime`, `LocalWallTime`, `readWarcraftUtc` (time/warcraft) | Calendar maths and display, with simulation time kept separate from untrusted wall time. |

## Minimal wiring example

```ts
const scope = new Scope(error => print(error));
const clock = new Scheduler();
const buffs = scope.add(new BuffStore<unit>(clock));
const damage = scope.add(createWarcraftDamage<{ kind: string }>({ onError: i => print(i.code) }));
const knockback = scope.add(new KnockbackSystem<unit>(new WarcraftKnockbackPort({ pathing: "terrain-point" })));

damage.beforeArmor(ctx => {
  if (ctx.metadata?.kind === "fire") ctx.amount *= 1.5;
  if (ctx.detail.damageType === DAMAGE_TYPE_MAGIC && buffs.has(ctx.target, "anti-magic")) ctx.cancel();
});
scope.own(clock.every(clock.stepSeconds, () => knockback.update(clock.stepSeconds)));

damage.start();                              // allocates damage triggers
scope.own(startWarcraftClock(clock));        // allocates the one timer
// ... later: scope.dispose(); clock.dispose();
```


## Buff example

```ts
const burning: BuffDefinition<unit> = {
  id: "burning", kind: "active", stacking: "independent", maxStacks: 5, duration: 3, interval: 1,
  onApply: b => { const fx = AddSpecialEffectTarget(model, b.target, "chest"); if (fx) b.own(() => DestroyEffect(fx)); },
  onTick: b => { damage.deal({ source: b.source as unit, target: b.target, amount: 10 * b.stacks }); },
};
buffs.apply(target, burning, caster); // each stack expires on its own timer; ticks at 1, 2 and 3 s
```

Always undo side effects with `buff.own(cleanup)`, never in ad-hoc code. The store guarantees each cleanup runs exactly once, whatever the removal reason.

## Missile example

```ts
const missiles = new MissileSystem(new WarcraftMissilePort({
  maxTargetRadius: 64, centerHeight: () => 60, eligible: u => IsUnitEnemy(u, owner),
  groundHeight: (x, y) => terrain.height(x, y),   // const terrain = new WarcraftTerrain()
}));
missiles.launch({
  position: start, velocity: { x: 600, y: 0, z: 700 }, acceleration: { x: 0, y: 0, z: -1400 },
  radius: 16, lifetime: 3,
  steer: (m, dt) => { m.velocity = turnToward(m.velocity, directionTo(target, m.position), 3 * dt); },
  onHit: (m, unit) => damage.deal({ source: caster, target: unit, amount: 50 }),
  onEnd: (m, reason) => { if (reason === "ground") explodeAt(m.position); },
});
```

The system owns its port: `missiles.dispose()` also releases the port's reusable group.

## Guides

[Patterns](docs/patterns.md) · [core](docs/core.md) · [buffs](docs/buffs.md) · [dummy](docs/dummy.md) · [damage](docs/damage.md) · [physics](docs/physics.md) · [persistence and time](docs/persistence-time.md) · [natives cheat sheet](docs/natives.md). Rules for contributors (human or AI): [AGENTS.md](AGENTS.md).

## Developing

Needs Deno ≥ 2.9.6. `deno install` fetches the dev-only npm toolchain (TypeScriptToLua 1.31.0, TypeScript 5.8.2, fengari).

```bash
deno task test          # Deno tests (JavaScript semantics)
deno task typecheck     # deno check + tsc over the modules, testbed and Lua harness
deno task lint          # includes the three Lua rules (lua-no-finally, lua-loop-closure, lua-truthiness)
deno task test:lua      # Lua harness + testbed dry run in fengari, with luaLibImport "require" and "require-minimal"
deno task build:testbed # dist/testbed.lua
deno task publish:dry   # deno publish --dry-run --allow-slow-types
```

`--allow-slow-types` is needed because JSR's public-API check can't see Warcraft's global types (`unit`, `player`, …). Maps compile the TypeScript sources, so this costs nothing in practice.

Deno green ≠ Lua green ≠ in-game green. fengari is a 64-bit Lua, so only `-selftest` in Warcraft catches 32-bit number and NaN issues.
