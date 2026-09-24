# Running library code in a real Lua 5.3 VM (`tools/lua-harness.ts`)

`deno task test` runs the library as **JavaScript**. The map runs it as **Lua 5.3** (via TypeScriptToLua). The two differ in ways that no Deno test can see: truthiness of `0`/`""`, `tostring` number formatting, float division, unstable `table.sort`, locale string comparison. The second pass found two real bugs of this kind (missile tie-break, save-code integers), so this harness exists to catch the next one.

## Running it

```bash
deno task test:lua
```

`tools/lua.ts` compiles `tools/lua-harness.ts` with the repo's `tsconfig.json`, runs it in fengari (a Lua 5.3 VM written in JavaScript, a dev dependency), and does the same for the testbed dry run (`testbed.md`). It does both twice, with `luaLibImport` set to `"require"` and to `"require-minimal"`, because maps may use either. It fails if any harness check fails, a Lua error is raised, or a testbed marker is missing.

A passing harness prints `N/N Lua checks passed`. **Limit:** fengari uses 64-bit numbers, while Warcraft uses 32-bit numbers and has broken NaN. Only the in-game `-selftest` catches those. It also prints `(observation rendered in Lua as "fire:4.0")`, which is expected and shows why numbers must be formatted before display.

## When to run it

- Any change to comparators, `||`/`&&`/`!` on values that can be numbers or strings, number ↔ text conversion, `%` with negative operands, or string comparisons.

Add a check to `lua-harness.ts` for every Lua-specific bug you fix. The harness is intentionally tiny (`check(name, actual, expected)`), so a check is one line.

## Why not run the Deno tests themselves in Lua?

They depend on `node:assert` and `Deno.test`. Porting them would mean a shim for deep equality in Lua. The targeted harness is cheaper, and the Deno tests remain the behavioural specification.
