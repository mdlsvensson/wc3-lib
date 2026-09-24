# Natives cheat sheet

Every Warcraft native the library and its testbed call, grouped by topic, with the file that calls it. `Blz*` natives were added in Reforged / patch 1.29+.

## Timers

| Native | Used in | Purpose |
|---|---|---|
| `CreateTimer`, `TimerStart`, `PauseTimer`, `DestroyTimer` | core/warcraft-clock.ts | the single 1/32 s heartbeat |
| same | damage/warcraft.ts | 0-second "end of frame" boundary for unpaired damage events |

## Triggers and events

| Native | Used in | Purpose |
|---|---|---|
| `CreateTrigger`, `TriggerAddAction`, `TriggerRemoveAction`, `DestroyTrigger` | damage, sync, testbed | event wiring |
| `TriggerRegisterPlayerUnitEvent` + `EVENT_PLAYER_UNIT_DAMAGING` / `_DAMAGED` | damage/warcraft.ts | the two damage events |
| `TriggerRegisterPlayerChatEvent`, `GetEventPlayerChatString` | testbed/main.ts | the testbed's chat commands |
| `BlzTriggerRegisterPlayerSyncEvent`, `BlzGetTriggerSyncData`, `BlzSendSyncData` | persistence/sync.ts | multiplayer data sync |
| `GetTriggerPlayer`, `GetPlayerId`, `Player`, `GetLocalPlayer` | sync, testbed | who fired the event, who is "me" |

## Damage

| Native | Purpose |
|---|---|
| `GetEventDamage`, `BlzSetEventDamage` | read and write the amount inside a damage event |
| `GetEventDamageSource`, `BlzGetEventDamageTarget` | who hit whom |
| `BlzGetEventIsAttack` | normal attack vs spell or script |
| `BlzGetEventAttackType/DamageType/WeaponType`, `BlzSetEvent…` | read and rewrite the hit's types (`ctx.detail`) |
| `UnitDamageTarget` | deal damage from script (`damage.deal`) |

## Units

| Native | Used in | Purpose |
|---|---|---|
| `CreateUnit`, `RemoveUnit` | dummy, testbed | create and remove |
| `GetUnitTypeId(u) !== 0` | buffs, physics, testbed | "does this unit still exist?" |
| `GetWidgetLife(u) > 0.405`, `IsUnitType(u, UNIT_TYPE_DEAD)` | physics, testbed | "is it alive?" (0.405 is Warcraft's death threshold) |
| `GetUnitX`, `GetUnitY`, `SetUnitX`, `SetUnitY` | physics | read and move without interrupting orders |
| `BlzGetUnitCollisionSize` | physics | default hit radius |
| `GetHandleId` | physics, testbed | stable tie-break ordering |
| `IsUnitEnemy`, `IsUnitAlly` | testbed | team rules |
| `IssuePointOrder`, `IssueTargetOrder`, `IssueImmediateOrder` | dummy, testbed | orders |
| `UnitAddAbility`, `GetUnitAbilityLevel`, `SetUnitAbilityLevel` | dummy | give the spell |
| `SetUnitInvulnerable`, `SetUnitPathing`, `SetUnitState`/`GetUnitState` | dummy | make a dummy safe; fill mana |
| `FourCC("Aloc")` | dummy | Locust ability: unselectable and untargetable |

## Groups (unit searches)

| Native | Purpose |
|---|---|
| `CreateGroup`, `GroupEnumUnitsInRange`, `FirstOfGroup`, `GroupRemoveUnit`, `DestroyGroup` | "all units within R of (x,y)". The testbed destroys its groups after use (never with `finally`, which is miscompiled). `WarcraftMissilePort` keeps **one** group, empties it after every query (`GroupClear`) and destroys it when its `MissileSystem` is disposed. |

Pattern: a group is created, used and destroyed inside one function, and the results are copied into a TS array (sorted by handle ID when order matters).

## Terrain

| Native | Purpose |
|---|---|
| `IsTerrainPathable(x, y, PATHING_TYPE_WALKABILITY)` | knockback terrain sampling. ⚠️ Returns **true when NOT pathable**; Warcraft's naming is inverted. |
| `Location`, `MoveLocation`, `GetLocationZ`, `RemoveLocation` | `WarcraftTerrain` (opt-in ground height for missiles) |

## Lua standard library in Warcraft (verified in game)

| API | Status |
|---|---|
| `os.date` | ✅ used by `readWarcraftUtc()` (`os.date("!*t")`) |
| `os.clock` | ✅ CPU time; used by `-stress` |
| `os.time` | ❌ missing |
| `string.format` | ✅ used by `integerText` |

## Effects and text

| Native | Purpose |
|---|---|
| `AddSpecialEffect`, `AddSpecialEffectTarget`, `DestroyEffect` | visuals (missiles, buff effects) |
| `BlzSetSpecialEffectPosition` | move a missile's effect in 3D |
| `CreateTextTag`, `SetTextTagText/Pos/Color/Permanent/Visibility`, `DestroyTextTag` | testbed labels (max 100 in a game) |

## Preload (local files)

| Native | Purpose |
|---|---|
| `PreloadGenClear`, `PreloadGenStart`, `Preload`, `PreloadGenEnd` | write a preload script file |
| `Preloader` | run a preload file (this is how we read) |
| `BlzGetAbilityTooltip`, `BlzSetAbilityTooltip` | the "mailbox" the file's data is read through |

## Things intentionally NOT used

| Native / API | Why not |
|---|---|
| `GetLocationZ` by default | can differ between clients under terrain deformation, so it's opt-in via `WarcraftTerrain` |
| `PauseUnit` in knockback | another system might have paused the unit; unpausing it would break that |
| Many individual `CreateTimer`s | one shared scheduler instead |
| `os.time` / JS `Date` | don't exist in Warcraft's Lua; use `readWarcraftUtc()` (local, untrusted) |
