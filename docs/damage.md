# Damage engine

Folder: `damage/`. Written from scratch. Damage Engine 5 was read for ideas only.

## The Warcraft background

Since patch 1.31, Warcraft fires two events for each hit:

| Native event | When | What you can do |
|---|---|---|
| `EVENT_PLAYER_UNIT_DAMAGING` | before armor and reductions | change the raw amount |
| `EVENT_PLAYER_UNIT_DAMAGED` | after armor, before HP is reduced | change the final amount |

Inside either event, `GetEventDamage()` reads and `BlzSetEventDamage()` writes the amount. The difficult parts, which every damage engine exists to handle:

1. Dealing damage **inside** a damage event (e.g. "thorns") starts a **new** event pair in the middle of the current one (nesting).
2. Sometimes a DAMAGING arrives **without** its DAMAGED (e.g. the hit is fully blocked).
3. A thorns-style listener can trigger itself forever.
4. You need to know *why* damage happened (was it the "fireball" spell or a normal attack?).

## The three phases

```ts
const damage = runtime.damage;

damage.beforeArmor(ctx => {           // DAMAGING
  if (ctx.isAttack) ctx.amount += 10;
  if (isImmune(ctx.target)) ctx.cancel();   // amount becomes 0 and stays 0
}, /* priority */ 0);

damage.afterArmor(ctx => {            // DAMAGED
  ctx.armorAmount;                    // what armor left
  ctx.amount *= 0.9;                  // 10% damage reduction
});

damage.observe(event => {             // after afterArmor; read-only COPY
  floatingText(event.target, event.amount);
});
```

### Attack, damage and weapon type (added in the second pass)

Every context carries `ctx.detail` with the engine's classification of the hit: `attackType`, `damageType`, `weaponType`. You can **read** it in any phase and **change** it in `beforeArmor`:

```ts
damage.beforeArmor(ctx => {
  if (ctx.detail.damageType === DAMAGE_TYPE_FIRE && hasFireShield(ctx.target)) ctx.amount *= 0.5;
  if (ctx.metadata?.kind === "true-damage") {
    ctx.detail.attackType = ATTACK_TYPE_CHAOS;        // changes which armor table applies
    ctx.detail.damageType = DAMAGE_TYPE_UNIVERSAL;    // ignores magic immunity rules
  }
});
```

The system writes your changes back with `BlzSetEventAttackType`/`DamageType`/`WeaponType` once, after all `beforeArmor` listeners. Changing it in `afterArmor` does nothing, because armor has already been applied by then.

### Lethal checks

```ts
import { isLethal } from "@mdlsvensson/wc3-lib/damage";
damage.afterArmor(ctx => {
  if (isLethal(ctx) && hasCheatDeath(ctx.target)) ctx.amount = GetWidgetLife(ctx.target) - 1;
}, 100 /* run late, after other reductions */);
```

`isLethal` compares the current amount against the target's life (Warcraft kills at 0.405 HP). It's a best guess: a listener that runs later, or mana shield, can still change the outcome.

- Lower priority runs first; equal priorities run in registration order.
- Each registration returns an unsubscribe function.
- **`observe` doesn't mean HP has already dropped.** It's the final amount Warcraft *will* apply.

## Dealing script damage with metadata

```ts
damage.deal({
  source: caster, target: enemy, amount: 120,
  metadata: { kind: "fireball" },                      // any object you like (type M)
  options: { attackType: ATTACK_TYPE_MAGIC, damageType: DAMAGE_TYPE_FIRE },
});

damage.beforeArmor(ctx => {
  if (ctx.metadata?.kind === "fireball" && isBurning(ctx.target)) ctx.amount *= 2;
});
```

Metadata attaches to the **first** DAMAGING event between that source and target, and only that one. It can't leak onto the next normal auto-attack.

`deal` wraps `UnitDamageTarget(source, target, amount, attack, ranged, attackType, damageType, weaponType)`. The defaults are not-an-attack, melee, `ATTACK_TYPE_NORMAL`, `DAMAGE_TYPE_NORMAL`, `WEAPON_TYPE_WHOKNOWS`.

## The queue: how nesting is kept sane

When a **listener** calls `deal(...)`, the damage isn't dealt immediately. It goes into a FIFO queue, which runs **after** the current event pair has finished. So:

- the current event's context (`damage.current`) is never overwritten by a nested one;
- thorns, lifesteal and chain effects happen in a clear order.

Safety limits (all reported as `[damage:<code>]` in red chat by our runtime):

| Code | Meaning | Default |
|---|---|---|
| `chain-limit` | more than `maxChain` deals without the queue ever becoming empty; the chain is cut | 64 |
| `queue-limit` | queue is full; the request is refused (`deal` returns false) | 128 |
| `pending-limit` | too many DAMAGING events waiting for their DAMAGED | 64 |
| `missing-damaged` | a DAMAGING never got its DAMAGED; cleared at the end of the frame. **Normal when spell immunity fully blocks a hit** (verified in game). | — |
| `unpaired-damaged` | a DAMAGED arrived with no matching DAMAGING; still processed, `paired: false` | — |
| `listener-error` | one of your listeners threw; the others still ran | — |

**How "end of the frame" works:** the adapter starts a 0-second timer on the first event of a burst. When it fires, `settled()` clears any unmatched frames and lets the queue continue.

## A bug fixed during review

The chain counter used to be a local variable in `drain()`. When a missing DAMAGED paused the queue, the next frame started counting from 0 again, so a self-triggering listener could loop forever, one frame at a time. It's now an instance field that only resets when the queue is truly empty.

## Natives wrapped (`warcraft.ts`)

`CreateTrigger`, `TriggerRegisterPlayerUnitEvent` (for every player slot, DAMAGING and DAMAGED), `TriggerAddAction`, `DestroyTrigger`, `GetEventDamageSource`, `BlzGetEventDamageTarget`, `GetEventDamage`, `BlzGetEventIsAttack`, `BlzSetEventDamage`, `BlzGetEventAttackType`/`DamageType`/`WeaponType`, `BlzSetEventAttackType`/`DamageType`/`WeaponType`, `GetWidgetLife` (`isLethal`), `UnitDamageTarget`, `CreateTimer`/`TimerStart`/`PauseTimer`/`DestroyTimer` (the frame boundary).

Type tip: the Warcraft flavour of the system is `WarcraftDamageSystem<M>` (M = your metadata type).

## Not supported on purpose (yet)

A built-in lethal-prevention event (use `isLethal` in a late `afterArmor` for now), AoE grouping, armor-piercing tricks. Each needs its own tested contract, not a quick hack.

## Display note

In Lua, `10 / 2` is the *float* `5.0`, so printing a damage amount can show `4.0` where JavaScript shows `4`. The value is the same (`4.0 == 4`); format numbers yourself (`math.floor`, `string.format`) before showing them to players.
