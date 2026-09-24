# Rules for AI agents (and humans) working on wc3-lib

Read this whole file before changing anything. Sections 2–4 were carried over from the project where the library was written and verified in game (wc3-main); they still hold.

## 1. What this is

- A **project-agnostic library** of Warcraft III systems (core, buffs, dummy, damage, physics, persistence, time), written in TypeScript for **TypeScriptToLua (TSTL) 1.31.0 → Lua 5.3** and published to JSR as `@mdlsvensson/wc3-lib`. Maps consume the **TypeScript sources**: wc3.dev-framework copies them into the map project and TSTL compiles them with the map, so only imported files are bundled.
- `testbed/main.ts` is a map entry point that exercises every module in game (`tools/testbed.md`). `tools/lua-harness.ts` checks Lua semantics in a Lua VM (`tools/lua-harness.md`).
- **Don't upgrade TSTL** without re-checking every hazard in §2; the workarounds and lint rules are tied to 1.31.
- ALICE and Damage Engine were **design references only**. Never vendor or copy their code.

## 2. Hard facts about the runtime (verified in game or by compiling and running TSTL output)

**Warcraft's Lua**
1. **Numbers are 32-bit.** Integers wrap past 2,147,483,647. Floats are single precision, so integers above 16,777,216 aren't exact and ~7 significant digits is all you get. Keep gold, HP, ids and timestamps under 2^31−1. Tolerances in float comparisons must be about 1e-4 to 1e-2, never 1e-9.
2. **NaN is broken:** `NaN == NaN` is true and `Number.isFinite(NaN)` is true. NaN can't be detected in game, so never produce it: validate divisors and `sqrt`/`acos` inputs first, and parse text with `tonumber`, never `Number()`.
3. **`os.time` does not exist; `os.date` and `os.clock` do.** Wall-clock UTC comes from `readWarcraftUtc()` (`time/warcraft.ts`, reads `os.date("!*t")`). It's local and untrusted until synced.
4. Messages printed during map load aren't displayed. The chat area shows about 16 lines.

**Warcraft engine behaviour**
5. A hit fully blocked by spell immunity fires DAMAGING but **no DAMAGED**, and the damage system reports `missing-damaged`. That's normal, not a bug.
6. Buff-applying spells (e.g. Slow) fire a **0-damage** event.
7. Creep abilities use `creep`-prefixed order strings (e.g. `ACtb` Storm Bolt → `"creepthunderbolt"`).
8. Stats are clamped (move speed max 400). **Undo the delta actually applied, not the delta requested** (see the `-buffs` haste code).

**TSTL 1.31 compiler hazards** (lint-enforced by `lint/wcraft-rules.ts` on the modules, `testbed/` and `tools/lua-harness.ts`)
9. `finally` is miscompiled: `try/finally` **swallows** the error; `try/catch/finally` **skips** the finally when catch rethrows. Write `try { … } catch (e) { cleanup(); throw e; } cleanup();`. Rule: `lua-no-finally`.
10. Closures capture **one shared** `for (let i …)` variable. Copy it (`const index = i;`) or use `for…of`. Rule: `lua-loop-closure`.
11. `0` and `""` are truthy in Lua. Never put a number or string on the left of `||`/`&&` or under `!`. Rule: `lua-truthiness`.
12. Callback properties must be typed `(this: void, …) => …`, otherwise a named function passed to an optional callback gets a hidden `self` and shifted arguments. Interface *method* signatures do take `self` (fine for classes implementing ports).
13. `table.sort` is unstable: comparators return explicit −1/0/1 and tie-break on a unique key. `String(n)` is Lua `tostring` (`5.0`); use `integerText` (→ `string.format("%d")`) for exact integer text. Compare characters by `charCodeAt`. `%` is floored in Lua.
14. TSTL does hoist functions and forward-declare module consts, so declaration order is safe.

## 3. Invariants

1. The library never imports map code (no rawcodes, grids or balance numbers; those come in as parameters). Modules import each other relatively with `.ts` extensions, never through the package name. Only `testbed/main.ts` and `tools/lua-harness.ts` import through `@mdlsvensson/wc3-lib/...`, the way a map does.
2. Importing allocates nothing. Handles are created by explicit `start()`/`create…()`/constructors. Every service has an idempotent `dispose()`, and `Scope` releases in reverse order.
3. Pure core + port interface + thin `warcraft*.ts` adapter. Only adapters call natives.
4. Deterministic: stable ordering (priority, creation order, handle-ID tie-break), no shared state changed inside `GetLocalPlayer` branches, and local data (files, clock) is synced before it touches gameplay.
5. Reentrant events use isolated state; script damage metadata can't leak to another hit.
6. A buff removes only what it applied (`buff.own(cleanup)`), and aura contributions per emitter are independent.
7. No dummy pooling and no missile spatial hash until measurements justify them.
8. Never label placeholder code as done, and never claim in-game behaviour without a Warcraft run.

## 4. Decisions a future agent might wrongly undo

- **Scheduler:** binary heap ordered by (due tick, creation order); creation order never changes on reschedule. Tick rounding tolerance `1e-4` (32-bit floats).
- **Buffs:** `startTicking()` runs before the first `addStack()`, so `duration 3 / interval 1` ticks 3 times. `BuffStore` deletes a unit's entry when its last buff goes. `removeOnDeath` defaults by kind (passives survive death) via `removedOnDeath()`.
- **Damage:** `detail` (attack/damage/weapon type) is written back once, in DAMAGING, after all `beforeArmor` listeners. The chain limit (64) survives missing-pair recovery. Listener deals are queued FIFO and drained after the current pair.
- **Physics:** `MissileSystem` owns and disposes its port. `WarcraftMissilePort` reuses one group, guarded by a `querying` flag (a reentrant query gets a private group). Ground is checked at the end of each step. `onEnd` runs after the visual is disposed. Update loops collect errors and keep going.
- **Persistence:** the codec checksum is folded to 31 bits, and numeric bounds are ±2^31−1. The player binding is mixed into the checksum with a `"\n"` separator. `unsigned()` stops before 32-bit overflow. Preload files are written in 180-character lines appended to a tooltip. Codes are hex (long but safe).
- **Missile systems are per feature, not global** (eligibility is policy, so a map creates one system per team or feature).

## 5. Opt-in rules (no overhead for unused systems)

A map that doesn't use a system must pay **0 bytes of script and 0 runtime** for it.

1. **One entry point per optional feature.** An entry point pulls in only what that feature needs. Barrels are allowed only where every re-exported file is needed together.
2. **Adapters are split per feature**: `physics/knockback/warcraft.ts` and `physics/missile/warcraft.ts`, not one `physics/warcraft.ts`. Shared geometry stays in `geometry.ts`; the one shared native helper is `physics/warcraft-living.ts` (not exported).
3. **Importing allocates nothing and registers nothing.** Only explicit `create…()`/`start()`/constructors do (invariant 2).
4. **No global singletons and no auto-start.** The library never decides what runs. The map composes it (a `Scope` owns the pieces).
5. **Core stays tiny.** `core/scheduler.ts` is the only dependency most systems share. `Scope` and `Signal` are opt-in.
6. **Nothing `require`s a module by string.** Module names in the bundle come from file paths and change when files move.

Pure cores (`damage/system.ts`, `physics/missile/system.ts`, …) stay importable on their own so maps can supply their own port.

**Guards** (`tests/opt-in.test.ts`, part of `deno task test`): (a) for every export in `deno.json`, the exact set of modules it bundles, compiled with TSTL. Changing that table must be a deliberate decision about cost. (b) Every module is loaded in fengari with **every Warcraft native replaced by a function that throws**. Importing must not call any.

## 6. How to verify a change

Every exported symbol (including public members) needs a JSDoc comment, and every file listed in `deno.json` `exports` starts with a `@module` doc with an `@example`. New entrypoints must also be added to the `check:docs` task. This keeps the JSR score at 100%.

Releases are published by `.github/workflows/publish.yml` when a `v*` tag is pushed (OIDC, so JSR records provenance). Bump `version` in `deno.json` first.

```bash
deno task test          # 80 tests: 77 behaviour tests (as JavaScript) + 3 opt-in guards (TSTL + fengari)
deno task typecheck     # deno check + tsc (modules, testbed, harness)
deno task lint          # includes the three Lua rules
deno task test:lua      # Lua harness + testbed dry run in fengari, both lualib modes
deno task check:docs    # JSDoc on every export, @module on every entrypoint, examples type-check (JSR score)
deno task publish:dry
```

- JS/Lua semantics (comparators, truthiness, number text, closures, error paths): `deno task test:lua`. fengari is a 64-bit VM, so it **cannot** catch 32-bit number issues. Add a harness check (`tools/lua-harness.ts`) for every Lua-specific bug you fix.
- Anything touching natives: the testbed dry run (part of `test:lua`), then **in game** with the testbed. `-selftest` is the only test that runs in Warcraft's real 32-bit Lua.

Report exactly what ran. Deno green ≠ Lua green ≠ in-game green.
