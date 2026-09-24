# Patterns and concepts

The same few ideas show up in every file. Once you recognise them, the code reads much faster.

## 1. Importing does nothing

No file creates a timer, trigger, group, unit or effect when it's imported. Handles are only created by an explicit call: `start()`, `startWarcraftClock()`, `createWarcraftDummies()`, a constructor documented to allocate, and so on.

**Why:** in Warcraft, code at the top level of a module runs during map init, sometimes before natives are safe to use, and in an order you don't control. Explicit starts put all of that in your map's own startup code (for example `src/main.ts`), where you can read it top to bottom.

## 2. Pure core + port + adapter

Every system is split in three:

```
DamageSystem<U>            pure logic, generic over the "unit" type, knows nothing about Warcraft
   │ talks only through
DamagePort<U>              a small interface: subscribe / setAmount / deal
   │ implemented by
WarcraftDamagePort         the ONLY place with natives (BlzSetEventDamage, UnitDamageTarget, ...)
```

| System | Pure core | Port interface | Warcraft adapter |
|---|---|---|---|
| Damage | `DamageSystem` | `DamagePort` | `WarcraftDamagePort` |
| Missiles | `MissileSystem` | `MissilePort`, `MissileVisual` | `WarcraftMissilePort`, `WarcraftMissileVisual` |
| Knockback | `KnockbackSystem` | `KnockbackPort` | `WarcraftKnockbackPort` |
| Dummies | `DummyManager` | `DummyPort` | inside `createWarcraftDummies` |
| Local files | `PreloadLocalStore` | `PreloadPort` | `createWarcraftPreloadPort` |
| Sync | `WarcraftSyncTransport` | `WarcraftSyncPort` | `createWarcraftSyncPort` |

**Why:** the pure part can be tested in milliseconds with fake ports (see [testing.md](testing.md)). The adapter is small enough to check by eye. Porting to another Warcraft version or a different w3ts only touches the adapter.

## 3. Ownership and idempotent dispose

Every handle has **exactly one owner**, and every owner has a `dispose()` that:

- releases everything it owns;
- is **safe to call twice** (idempotent): the second call does nothing;
- keeps going if one cleanup throws, then reports the error.

The common shape. The library packages it as `Scope` (`core/scope.ts`); prefer `Scope` in new code:

```ts
const cleanups: (() => void)[] = [];
cleanups.push(clock.every(0.5, tick));      // every/after return their own cancel function
cleanups.push(() => missiles.dispose());
...
let disposed = false;
return () => {
  if (disposed) return;
  disposed = true;
  for (let i = cleanups.length - 1; i >= 0; i--) {   // reverse order: undo newest first
    try { cleanups[i](); } catch (e) { report(e); }
  }
};
```

For buffs: `buff.own(cleanup)` attaches a cleanup to a buff, and it runs exactly once however the buff ends (expired, dispelled, death, ...).

**Why:** Warcraft handle leaks are silent and add up (lag over long games). "Who destroys this?" should always have an obvious answer.

## 4. Cancel functions instead of IDs

`clock.after(...)`, `clock.every(...)`, `signal.subscribe(...)` and `damage.beforeArmor(...)` all return `() => void`. Call it to undo the registration. Store it with the other cleanups. No handle IDs, no "unregister by name".

## 5. One clock, fixed steps

A single Warcraft timer calls `Scheduler.advance()` every 1/32 s. All timing is in **whole ticks**; seconds are rounded **up** (`0.1 s` → 4 ticks = 0.125 s).

**Why:** everything happens in a predictable order on a shared timeline. Tests can step time exactly, and many small Warcraft timers (each a handle, each drifting a little) are avoided.

## 6. Deterministic ordering

Multiplayer Warcraft only works if every client runs the same code in the same order. So:

- listeners run by **priority, then registration order** (Signal, damage phases);
- missile hits sort by **distance along the path, then handle ID**;
- sort group enumeration results by `GetHandleId` when order matters, because group order isn't guaranteed.

## 7. JavaScript is not Lua

The TypeScript is compiled to Lua 5.3, and a few things silently mean something different there. Deno tests run the code as JavaScript, so **they cannot catch these**:

- `0` and `""` are **truthy** in Lua. `a - b || c - d` never reaches `c - d`, and `if (!list.length)` is never true. Compare explicitly. `deno task lint` flags the common forms (rule `wcraft-rules/lua-truthiness`).
- `String(x)` is Lua `tostring`: floats print with 14 significant digits, and integers stored as floats print as `4.0`. Use `integerText` (persistence/format) when text must be exact.
- **Numbers are 32-bit in Warcraft** (verified in game): integers wrap past 2,147,483,647, and floats are exact only up to 16,777,216 (~7 digits). Keep gold, HP and ids well under 2^31, and compare floats with tolerances like 0.01.
- **NaN == NaN is true in Warcraft**, so NaN can't be detected. Never create it.
- **Engines clamp stats** (move speed max 400): when a buff changes a stat, undo the amount actually applied, not the amount you asked for (see [buffs.md](buffs.md)).
- `/` always produces a float (`10 / 2` is `5.0`). Harmless for maths, visible when printed.
- `sort` is Lua's `table.sort`, which is **not stable**. Always tie-break on a unique key.
- String comparison with `<` uses the C locale. Compare `charCodeAt` values instead.
- **`finally` is broken** in the pinned TypeScriptToLua (1.31). `try { } finally { }` runs the cleanup but **hides the error**; `try { } catch { throw } finally { }` rethrows but **skips the cleanup**. Write `try { … } catch (e) { cleanup(); throw e; } cleanup();`. `deno task lint` rejects `finally` (rule `lua-no-finally`).
- **Loop variables are shared.** In `for (let i = 0; …)`, every closure (callbacks, timers) sees the *last* `i`. Copy it first: `const index = i;`. Lint rule `lua-loop-closure`.
- **Callbacks and `self`.** TypeScriptToLua can pass a hidden first argument to functions stored on objects. The library declares its callbacks `(this: void, …)` so this never bites; if you write your own interfaces with callbacks, do the same, and prefer properties over method signatures for them.

[`tools/lua-harness.md`](../tools/lua-harness.md) explains how to run library code in a real Lua 5.3 VM when you touch any of this.

Never use `GetLocalPlayer()` to change shared state. The only such branch is `send` in the sync module, which is exactly what it's for.

## 7. Safe changes during a callback (reentrancy)

A classic Warcraft bug is a buff whose removal callback removes another buff while the list is being looped. The library handles this consistently:

- **Snapshot then check:** loops iterate over `list.slice()` and skip entries whose callback was cleared (`callback = undefined`) mid-loop.
- **Removal takes effect immediately**: a listener removed during dispatch won't run later in that same dispatch.
- **Additions wait**: a listener or task added during dispatch first runs on the next event or tick.
- **No re-entering updates**: `missiles.update()` inside `missiles.update()` throws instead of corrupting state.

## 8. Results instead of exceptions for expected failures

Persistence returns `Result<T>`:

```ts
const r = codec.decode(text);
if (!r.ok) print(`bad save: ${r.error}`);   // "checksum", "version", "truncated", ...
else use(r.value);
```

Bad player input (a corrupted save code) is *expected*, so it's a value to check, not a crash. Programmer mistakes (negative duration, NaN positions) still **throw**, because those are bugs.

## 9. Validate at the edge

Every public method checks its numbers (`Number.isFinite`, positive, integer) before using them, and fails loudly at the call that caused the problem.

⚠️ In Warcraft these checks catch **infinity but not NaN**: NaN compares equal to itself there (verified in game). So *don't produce* NaN: check divisors before dividing, and parse text with `tonumber` instead of `Number()`.

## 10. Generic unit type `<U>` / `<T>`

`BuffStore<unit>` in game and `BuffStore<string>` in tests. Systems never call methods on the unit; they only compare and store it. That's what makes them testable and portable.

## TypeScript → Lua gotchas (TSTL)

- **`this: void`**: in Lua, methods take a hidden `self` argument. TSTL has to know whether a function type has one. If you see *"Unable to convert function with no 'this' parameter"*, declare the type as `fn(this: void, ...)` or use a plain arrow-function type.
- **No `JSON`, `RegExp` or `Date` at runtime.** They're fine inside `compiletime(...)` (which runs during the build), but not in game code.
- **Arrays are 1-based in Lua**, but TSTL converts them for you. Don't put `undefined` holes in arrays; Lua loops stop at the first `nil`.
- `Map` and `Set` work; TSTL ships its own implementation (that's where `Symbol` in the Lua bundle comes from).
