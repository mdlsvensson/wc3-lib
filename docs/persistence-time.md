# Save/load, local files, sync, and time

Folders: `persistence/`, `time/`.

## Big picture

Saving in Warcraft has three separate problems, and this module solves each one separately:

```
game data ──SaveCodec.encode──► save code text ──PreloadLocalStore.write──► file on player's PC
                                     ▲                                          │
                              (copy/paste works                        PreloadLocalStore.read
                               with no files at all)                           │ (only on that player's PC!)
                                     │                                          ▼
game data ◄──SaveCodec.decode── validated text ◄──WarcraftSyncTransport── local text
                                                 (sends it to ALL players)
```

1. **Codec:** data ↔ text, versioned and checked.
2. **Local file:** text ↔ disk, only on one player's machine.
3. **Sync:** one player's text → every player's game, so multiplayer doesn't desync.

## 1. `codec.ts` — `SaveCodec`

You describe your save with a **schema**:

```ts
const v1: SaveSchema = {
  version: 1,
  fields: [
    { key: "gold",  kind: "number", min: 0, max: 1_000_000, integer: true },
    { key: "hero",  kind: "string", maxLength: 16 },
    { key: "hard",  kind: "boolean" },
  ],
  migrate: old => ({ ...old, gems: 0 }),   // turns a v1 save into v2
};
const v2: SaveSchema = { version: 2, fields: [...v1.fields, { key: "gems", kind: "number", min: 0, max: 999 }] };

const codec = new SaveCodec(2, [v1, v2]);
const out = codec.encode({ gold: 500, hero: "Thrall", hard: false, gems: 3 });
// out.value: "W3S1:<hex>:<checksum>"
const back = codec.decode(out.value);   // { ok: true, value: {...} } or { ok: false, error: "checksum" }
```

What a code looks like inside: `version;` followed by `length:value` for each field, hex-encoded, then an Adler-style checksum.

- Old codes still load: the codec runs `migrate` step by step (v1 → v2 → ...) and re-validates after each step.
- It rejects: a wrong checksum, an unknown version, truncated input, extra bytes, out-of-range values, and extra or missing fields.
- ⚠️ **The checksum catches typos, not cheaters.** Anyone who reads the code can forge a save. Anti-cheat would need a secret-keyed signature, which isn't done.
- The number parser is hand-written, because JS and Lua parse strings like `"0x10"` or `" 5"` differently.

**Binding a code to a player** (second pass): `codec.encode(data, GetPlayerName(p))` and `codec.decode(code, GetPlayerName(p))`. The name is mixed into the checksum, so a friend's code fails with `checksum`. It stops casual sharing, not determined cheaters.

**Numbers:** Warcraft's Lua has **32-bit numbers** (found in game). Numeric fields must fit in ±2,147,483,647 (the codec rejects wider bounds), and integers are written exactly with `string.format("%d")`. Floats keep only ~7 significant digits, so store fractions as scaled integers (e.g. `hp * 100`). The checksum is folded to 31 bits for the same reason, so codes made before 2026-09-23 no longer load.

## 2. `local-file.ts` — `PreloadLocalStore`

Warcraft has no real file API. The well-known trick is **Preload files**:

- **Write:** `PreloadGenClear` → `PreloadGenStart` → `Preload(line)` → `PreloadGenEnd(path)`. This writes a script file into the player's `CustomMapData` folder.
- **Read:** `Preloader(path)` *runs* that file. The file's first line is `call BlzSetAbilityTooltip(<ability>, "W3L1<first 180 hex chars>", 0)` and each further line appends the next 180 characters (`BlzGetAbilityTooltip(<ability>, 0) + "..."`), so running it rebuilds our data in an ability tooltip. We read that tooltip with `BlzGetAbilityTooltip`, then restore the original tooltip.
- Why 180-character lines: a single `Preload` string is truncated somewhere around 255+ characters (community FileIO libraries all split for this reason). The first pass wrote up to 8,192 characters on one line. The exact limit on the current client is still unverified, so the chunk size is deliberately conservative.

```ts
const store = new PreloadLocalStore("MyMap", FourCC("Axxx") /* reserved ability */, createWarcraftPreloadPort());
store.write("slot1", code);   // { ok: true, value: { status: "issued-unverified" } }
const r = store.read("slot1"); // only meaningful for the local player
```

Safety measures:

- slot names are restricted identifiers, so no `..\` path tricks;
- data is hex-only, so a crafted save can't inject code into the preload file;
- the tooltip is always restored, even if reading fails;
- `issued-unverified`: Warcraft never confirms a write succeeded.

A bug fixed during review: `write` now clears the preload buffer **before** starting, so unrelated buffered lines can't end up in your file.

⚠️ Reforged's current support for preload read/write must be **tested in game**. Treat local files as a convenience; copy/paste codes are the reliable fallback.

## 3. `sync.ts` — `SyncReceiver`, `WarcraftSyncTransport`

`read()` only gives data to **one** player. If you apply it directly, the other players' games desync. So:

1. The local player's client calls `transport.send(playerId, sessionId, code)`. The code is split into chunks and sent with `BlzSendSyncData`.
2. **All** clients receive the chunks (`BlzTriggerRegisterPlayerSyncEvent`), check that the sender is allowed and was `expect()`ed, reassemble them (even out of order), and call `onCode(sender, code)` on everyone at the same moment.
3. Then `codec.decode` and your game rules decide whether to accept it.

Limits: a maximum code length, a maximum number of pending transfers, and a TTL (15 s default) after which incomplete transfers are dropped. Replayed or duplicate chunks are rejected.

## 4. Time — `time/index.ts`

Three kinds of time are deliberately kept apart:

| Kind | Source | Same on all clients? | Use for |
|---|---|---|---|
| Simulation | `new SimulationTime(clock).elapsed` | ✅ yes | cooldowns, rounds, anything in gameplay |
| Wall clock | `new LocalWallTime(source).read()` | ❌ no | display only, "last saved at" |
| Calendar maths | `utcToUnix`, `unixToUtc`, `isLeapYear`, `dayOfWeek` | pure | converting timestamps |
| Display | `formatDuration(125)` → `"2:05"`, `formatUtc(date)` → `"2000-02-29 00:00:00"` | pure | timers, round clocks, "saved at" |

`LocalWallTime` returns `{ unixSeconds, authority: "local-untrusted" }`. The label is there to remind you: never base shared rewards on the player's PC clock.

**Wall clock in Warcraft:** `os.time` does **not** exist (verified in game), but `os.date` does. `readWarcraftUtc()` in `time/warcraft.ts` reads `os.date("!*t")` and converts it to Unix seconds, the same approach as WCSharp.DateTime: `new LocalWallTime(readWarcraftUtc).read()`. Each player gets their own PC's time, so sync it (e.g. every player sends theirs, all agree on the median) before it affects gameplay. That sync isn't built yet. Timestamps overflow 32-bit integers in 2038.

**Natives wrapped:** `PreloadGenClear`, `PreloadGenStart`, `Preload`, `PreloadGenEnd`, `Preloader`, `BlzGetAbilityTooltip`, `BlzSetAbilityTooltip`, `BlzSendSyncData`, `BlzTriggerRegisterPlayerSyncEvent`, `BlzGetTriggerSyncData`, `GetTriggerPlayer`, `GetPlayerId`, `GetLocalPlayer`, `Player`, `CreateTrigger`/`TriggerAddAction`/`TriggerRemoveAction`/`DestroyTrigger`.
