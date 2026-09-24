# The in-game test bed (`testbed/main.ts`)

A map entry point that exercises every library module through chat commands. It imports only the library (through the package name, like a map) and w3ts hooks, and uses built-in object data (Footman, Grunt, Knight, Paladin, Sorceress as a stand-in dummy, creep abilities), so it runs in any map, including wc3.dev-framework's template.

## Using it in Warcraft

1. Build a map with `testbed/main.ts` as its entry point. *(wc3.dev-framework is getting an option for this in migration phase 3. Until then, use wc3-main's copy, `lib/testbed/main.ts`, following wc3-main's `local/tools/testbed.md`.)*
2. In game type `-help` (compact list; `-help <command>` explains one). Every test clears the screen, then prints `what:` (the mechanic) and `look for:` (what correct looks like). `-cls` clears text.
3. `-clear` between tests.

`deno task build:testbed` compiles it to `dist/testbed.lua` on its own. `deno task typecheck` and `deno task lint` cover it.

| Command | Verifies in the engine |
|---|---|
| `-selftest` | the pure library logic under Warcraft's own Lua (17 checks) |
| `-clock` | scheduler rounding and drift against a native timer |
| `-buffs`, `-aura` | DoT stacks, refresh, death policy, independent aura contributions |
| `-damage`, `-log`, `-spell`, `-thorns`, `-loop`, `-cheatdeath` | native damage events, attack/damage type rewrite vs spell immunity, nested damage, chain limit, `isLethal` |
| `-dummy` | dummy casting and caster attribution |
| `-missile`, `-arc`, `-homing`, `-knock`, `-stress [n]` | swept hits, gravity/ground, homing, knockback falloff and pathing, physics CPU cost (needs `os.clock`) |
| `-save [gold]`, `-load`, `-code <code>`, `-migrate` | Preload write/read, sync to all players, player binding, migrations (not yet run in game) |
| `-time` | build and simulation time, plus the local UTC wall clock via `os.date` (Warcraft has no `os.time`) |

**Run `-load` and `-save` with 2+ players at least once**: that's the only real test of the sync path.

## Smoke-running it without Warcraft

`testbed-stubs.lua` is a small fake Warcraft API (units, triggers, timers, damage events, Preload files, sync). `run-testbed.lua` drives every command through the real chat trigger and prints the output. It catches Lua runtime errors and compiler hazards, not engine behaviour: spell immunity, pathing and real casting are not simulated.

`deno task test:lua` runs it (after the Lua harness) with both lualib modes and writes the transcripts to `dist/lua-<mode>/testbed-run.txt`.

A healthy run shows `selftest: 17/17 passed`, `loop: 64 hits`, `cheated death`, `knockback ends: replaced 1, completed 6`, a synced load, and no `LUA ERROR` or red `[...]` lines other than the expected `[damage:chain-limit]`.

In-game results at hand-off (from wc3-main, 2026-09-23): everything above was verified in single player except `-save`/`-load`/`-code`/`-migrate`, multiplayer sync, `-knock` near cliffs, and the re-runs of `-buffs` and `-time` after their last fixes.
