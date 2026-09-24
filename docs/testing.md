# Testing

There are five layers. Each catches different problems and none replaces the others.

| Layer | Command | Proves | Doesn't prove |
|---|---|---|---|
| Behaviour tests | `deno task test` | Logic: ordering, cleanup, limits, edge cases (run as JavaScript, type-checked) | Lua behaviour, engine behaviour |
| Opt-in guards | part of `deno task test` (`tests/opt-in.test.ts`) | Each export bundles only its own modules; importing calls no native | Anything about behaviour |
| Type, lint | `deno task typecheck`, `deno task lint` | Types; the Lua-safety lint rules | That it does the right thing in game |
| Lua VM | `deno task test:lua` ([`tools/lua-harness.md`](../tools/lua-harness.md)) | The compiled Lua behaves like the JS (truthiness, sorting, number text, closures); the testbed runs against a fake Warcraft API | Warcraft's 32-bit numbers and NaN (the VM is 64-bit) |
| In-game testbed | `testbed/main.ts`, `-selftest` and the other commands ([`tools/testbed.md`](../tools/testbed.md)) | Real Warcraft behaviour, real 32-bit Lua | Multiplayer (needs 2+ clients) |

Three real bugs were invisible to the Deno tests and only showed up in the Lua VM or in game. Deno green doesn't mean in-game green.

## How library tests work without Warcraft

Every system takes its engine access through a small interface, called a **port** (see [patterns.md](patterns.md#2-pure-core--port--adapter)). In tests we pass a fake port that records what happened:

```ts
// from tests/damage.test.ts (simplified)
class NativeDamage implements DamagePort<string, undefined> {
  writes: number[] = [];
  setAmount(amount: number) { this.writes.push(amount); }   // instead of BlzSetEventDamage
  ...
}
const system = new DamageSystem(new NativeDamage());
```

Units are plain strings like `"a"` or `"outer"`, or numbers. The systems are generic (`DamageSystem<U>`), so they don't care.

Adapter tests go one level lower. They **replace the Warcraft natives on `globalThis`** with fakes, run the real `warcraft*.ts` code, then put the originals back:

```ts
const native = globalThis as unknown as Record<string, unknown>;
native.PreloadGenClear = () => calls.push("clear");
...
try { /* run real adapter */ } finally { /* restore globals */ }
```

(`finally` is fine here: test files run in Deno as JavaScript. It's banned in the library code, which compiles to Lua.)

That checks which natives get called and in what order, without a game.

## The scheduler makes time testable

Nothing waits for real time. Tests call `clock.advance()` to move exactly one tick (1/32 s):

```ts
const clock = new Scheduler();
buffs.apply(unit, { id: "x", kind: "active", duration: 1 });
for (let i = 0; i < 32; i++) clock.advance();   // exactly 1 second later
assert.equal(buffs.list(unit).length, 0);        // expired
```

Physics is the same idea: call `missiles.update(0.1)` and check where things ended up.

## Writing your own test

1. Open the matching `tests/<module>.test.ts`.
2. Add a test:

```ts
Deno.test("rally buff expires after its duration", () => {
  const clock = new Scheduler();
  const buffs = new BuffStore<string>(clock);
  buffs.apply("footman", { id: "rally", kind: "active", duration: 0.5 });
  for (let i = 0; i < 16; i++) clock.advance();
  assert.equal(buffs.list("footman").length, 0);
});
```

3. Run only that file while iterating:

```bash
deno test -A tests/buffs.test.ts
```

4. Then run the full `deno task test`, `deno task typecheck` and `deno task lint`.

**Good habit (test-first):** write the test, watch it **fail**, then write code until it passes. A test you never saw fail might not be testing anything.

## What the tests cover today

- **core:** cancel during a tick, callbacks added mid-tick wait a tick, equal deadlines keep order, error recovery.
- **buffs:** two aura emitters stay independent, stack caps, independent stack expiry, removal inside callbacks.
- **dummy:** creation failures clean up, disposing twice is safe.
- **damage:** phase order, nested events, metadata isolation, queue and chain limits, cancel/zero, missing event pairs, dispose mid-listener, attack/damage type detail.
- **physics:** fast missiles not tunnelling, hit order and tie-breaks, piercing, gravity/ground, homing, end reasons, error isolation, knockback replacement and falloff, blocked moves, terrain sampling, group reuse.
- **opt-in guards:** the exact modules each export bundles; no native called while importing any module.
- **persistence:** corruption, truncation, migration, bad file content, sync authorization, replay, expiry.
- **time:** leap years, century rules, negative timestamps.

## Checking the generated Lua

`deno task build:testbed` writes `dist/testbed.lua`, and `deno task test:lua` leaves each bundle it runs under `dist/lua-<mode>/`. If something behaves oddly in game, search those files for your function to see what Lua actually runs. Also worth checking now and then that nothing uses `JSON`, `RegExp` or `Date`; those don't exist in Warcraft's Lua.
