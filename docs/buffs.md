# Buffs and auras

Folder: `buffs/`. `@mdlsvensson/wc3-lib/buffs` gives `BuffStore` and `trackWarcraftBuffTargets`; auras are a separate import, `@mdlsvensson/wc3-lib/buffs/aura`. These are **script buffs**: state that lives in TypeScript. They are *not* Warcraft's native ability buffs and don't show an icon in the unit's buff bar unless you add that yourself.

## The two types: definition vs instance

- `BuffDefinition<T>` is **what** a buff is. It's static data you declare once: id, kind, stacking, duration, hooks.
- `BuffInstance<T>` is **one** buff on **one** target from **one** source. `BuffStore.apply` creates it.

An instance is identified by **(target, source, definition id)**. That's the key idea: the same buff from two different sources gives two independent instances.

## Declaring and applying

```ts
const slow: BuffDefinition<unit> = {
  id: "slow",
  kind: "active",            // "active" | "passive" | "aura"
  stacking: "refresh",       // see table below
  duration: 3,               // seconds; omit for permanent (passive)
  maxStacks: 1,
  removeOnDeath: true,       // default: true, EXCEPT kind "passive", which defaults to surviving death
  interval: 1,               // optional: call onTick every second while active
  onApply:  buff => { /* start effect */ },
  onTick:   buff => { /* damage/heal over time; throwing removes the buff with reason "error" */ },
  onStacks: (buff, previous) => { /* stack count changed */ },
  onRemove: (buff, reason) => { /* reason: expired, dispelled, death, ... */ },
};

const buff = runtime.buffs.apply(target, slow, caster);
buff.stacks; buff.active; buff.remove("dispelled");
buff.remaining;                            // seconds left (undefined if permanent) — for UI
buff.data.bonus = 50;                      // free storage for the effect's own state
runtime.buffs.has(target, "slow");         // any source
runtime.buffs.get(target, "slow", caster); // one instance
runtime.buffs.stacks(target, "sunder");    // stacks summed over every source
runtime.buffs.list(target);                // all buffs on a unit (a copy)
runtime.buffs.clearTarget(target);         // e.g. on unit removal
runtime.buffs.clearSource(caster);         // e.g. caster died, remove what they applied
```

Tick timing: a buff with `duration: 3, interval: 1` ticks **three** times (at 1, 2 and 3 seconds); the last tick runs on the same tick as expiry, before it. The store keeps buffs indexed per unit, so `has`/`stacks` are cheap enough to call inside damage listeners.

## Stacking policies

What happens when you `apply` again with the same target, source and id:

| `stacking` | Stacks | Duration |
|---|---|---|
| `refresh` (default) | stays at 1 | timer restarts |
| `replace` | old instance removed (`onRemove(..., "replaced")`), new one created | fresh |
| `stack` | +1 up to `maxStacks` | **one shared** timer restarts; all stacks drop together |
| `independent` | +1 up to `maxStacks` | **each stack has its own timer** and drops alone; reapplying at the cap does nothing |

## Undoing effects: `buff.own(cleanup)`

The most important rule in this module: **when a buff changes something, register how to undo it.**

```ts
onApply: buff => {
  const fx = AddSpecialEffectTarget(model, buff.target, "overhead");
  if (fx) buff.own(() => DestroyEffect(fx));
  // Undo what was APPLIED, not what was asked: Warcraft clamps values (move speed 0..400).
  const before = GetUnitMoveSpeed(buff.target);
  SetUnitMoveSpeed(buff.target, before - 50);
  const applied = GetUnitMoveSpeed(buff.target) - before;
  buff.own(() => SetUnitMoveSpeed(buff.target, GetUnitMoveSpeed(buff.target) - applied));
},
```

Cleanups run in reverse order, exactly once, whatever the removal reason. If you call `own` on a buff that's already gone, the cleanup runs immediately, so nothing leaks.

## Auras — `aura.ts`

An `Aura` is a buff *emitter*. Every time you call `update()` it asks "who should have this now?" and adds or removes instances to match (called **reconciliation**):

```ts
const aura = new Aura(buffs, rallyDefinition, captain /* source */, () =>
  unitsNear(captain, 700).filter(isAlly)).start(clock, 0.5);  // reconcile now, then every 0.5 s
// later
aura.dispose();          // stops its timer and removes every instance this aura added
```

The query must return units in the same order on every client (sort by `GetHandleId`), because the order decides which `onApply` runs first.

- The definition must have `kind: "aura"`.
- Because the source is part of the key, **two captains = two independent instances** on a unit in range of both. Losing one captain removes only its instance. (The design calls this "source-keyed contributions".)
- The query function decides range, allies, visibility. The aura doesn't make those rules.

## Death and removal — `warcraft-buffs.ts`

```ts
trackWarcraftBuffTargets(store, clock);   // once, next to the store
```

Every 0.25 s it calls `store.prune(...)`:

- a unit that no longer exists (`GetUnitTypeId(u) === 0`) loses all buffs with reason `removed`;
- a dead unit (`IsUnitType(u, UNIT_TYPE_DEAD)`) loses the buffs that are removed on death (default: everything except passives), reason `death`.

Polling is used instead of a death trigger because `RemoveUnit` fires no event. The interval is the optional third argument.

**Natives:** `GetUnitTypeId`, `IsUnitType`.

## Using buffs in damage

Buffs hold no stats themselves. Other systems *read* them:

```ts
damage.beforeArmor(ctx => {
  if (buffs.has(ctx.source, "demo.rally")) ctx.amount *= 1.25;
});
```

This keeps buffs generic. A buff can mean "+25% damage", "can't be healed" or "counts as a hero". The meaning lives in whichever system checks for it.
