# Dummy units

Folder: `dummy/`.

## What a dummy is (classic WC3 concept)

A **dummy** is an invisible, unselectable unit you create just to cast a real Warcraft ability, for example "make it look like a Frost Nova hit here" or "apply the native slow buff with its icon". Many classic maps create one per spell and forget to remove it. This module makes the cleanup automatic.

## API

```ts
const lease = runtime.dummies.cast({
  owner: GetOwningPlayer(caster),
  rawcode: FourCC("dumy"),        // YOUR dummy unit from objects/*.pkl
  x, y, facing: 0,
  ability: FourCC("A000"),        // ability to add to the dummy
  level: 2,
  order: "frostnova",             // order string of that ability
  target: enemy,                  // OR point: { x, y }, OR neither (instant cast)
  duration: 1.5,                  // how long before the dummy is removed
  source: caster,                 // optional: the real caster, for damage attribution
});
lease.orderAccepted;   // did Warcraft accept the order? (NOT "did the spell hit")
lease.dispose();       // remove early; safe to call twice
```

### Who really dealt the damage?

When a dummy casts Frost Nova, Warcraft says the **dummy** dealt the damage, so kill credit, lifesteal and "damage by hero" logic break. Pass `source` and resolve it in a damage listener:

```ts
damage.beforeArmor(ctx => {
  const caster = runtime.dummies.sourceOf(ctx.source) ?? ctx.source;
  // use caster for bonuses, kill credit, etc.
});
```

`sourceOf` only works while the dummy is alive. That's one more reason `duration` must include the **projectile travel time** (Storm Bolt from far away), not just the cast.

What `cast` does, in order:

1. **create** → `CreateUnit(owner, rawcode, x, y, facing)`
2. **configure** → adds `Aloc` (locust: unselectable, untargetable), `SetUnitInvulnerable`, `SetUnitPathing(false)`, adds the ability, sets its level, fills mana
3. **order** → `IssueTargetOrder`, `IssuePointOrder` or `IssueImmediateOrder`
4. schedules `RemoveUnit` after `duration` on the shared clock

If any step fails, the dummy is removed right away and the error is thrown. You never get a half-created dummy left lying around.

## Important rules

- **`duration` must cover the whole cast.** Removing a dummy before its cast point or channel finishes cancels the spell. For channels, use the channel time plus a margin.
- **No pooling (reusing dummies), on purpose.** A pooled dummy keeps leftover abilities, levels and owner from its last use. Fresh units are slightly more expensive but always clean. Add pooling only if profiling shows it's needed.
- The library never knows your rawcodes. You pass them in.

## Status

`DummyManager` is verified in game (the testbed `-dummy` test: Slow and Storm Bolt cast, bolt damage credited to the caster), using a visible Sorceress as a stand-in. The game (`runtime.dummies`) doesn't use it yet because the map has no real dummy unit type. **Order strings:** creep abilities use `creep`-prefixed orders (Storm Bolt `ACtb` → `"creepthunderbolt"`, not `"thunderbolt"`), otherwise the order is refused. To start using it, add a dummy to `objects/definitions/units.pkl` with:

- no model (or a blank `.mdl`) and no shadow;
- the Locust ability;
- cast point 0 and cast backswing 0 (otherwise casts are delayed);
- flying movement, so it's never blocked;
- enough mana, or abilities with 0 mana cost.

**Natives wrapped:** `CreateUnit`, `UnitAddAbility`, `SetUnitInvulnerable`, `SetUnitPathing`, `GetUnitAbilityLevel`, `SetUnitAbilityLevel`, `SetUnitState`/`GetUnitState` (mana), `IssueTargetOrder`, `IssuePointOrder`, `IssueImmediateOrder`, `RemoveUnit`.
