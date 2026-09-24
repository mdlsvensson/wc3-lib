/**
 * Warcraft adapter for `DamageSystem`: `WarcraftDamagePort` (DAMAGING/DAMAGED triggers,
 * `UnitDamageTarget`), `createWarcraftDamage` and `isLethal`.
 *
 * @example
 * ```ts
 * import { createWarcraftDamage, isLethal } from "@mdlsvensson/wc3-lib/damage/warcraft";
 *
 * const damage = createWarcraftDamage();
 * damage.afterArmor(context => { if (isLethal(context)) BJDebugMsg("killing blow"); });
 * damage.start();
 * ```
 *
 * @module
 */

import { DamageSystem, type DamagePort, type DamageRequest, type DamageSystemOptions } from "./system.ts";

/** Warcraft options for `DamageSystem.deal` requests. */
export interface WarcraftDamageOptions {
  /** Count the damage as an attack. Default false. */
  readonly attack?: boolean;
  /** Count the damage as ranged. Default false. */
  readonly ranged?: boolean;
  /** Default `ATTACK_TYPE_NORMAL`. */
  readonly attackType?: attacktype;
  /** Default `DAMAGE_TYPE_NORMAL`. */
  readonly damageType?: damagetype;
  /** Default `WEAPON_TYPE_WHOKNOWS`. */
  readonly weaponType?: weapontype;
}

/**
 * Engine classification of the current hit. Mutating it in beforeArmor rewrites the event
 * (e.g. damageType = DAMAGE_TYPE_UNIVERSAL to bypass magic immunity rules, or
 * attackType = ATTACK_TYPE_CHAOS to change the armor table). Changes in later phases do nothing.
 */
export interface WarcraftDamageDetail {
  /** Attack type; picks the armor table. */
  attackType: attacktype | undefined;
  /** Damage type; decides immunity and spell reduction. */
  damageType: damagetype | undefined;
  /** Weapon type; decides the impact sound. */
  weaponType: weapontype | undefined;
}

/** A `DamageSystem` over Warcraft units, created by `createWarcraftDamage`. M is caller metadata. */
export type WarcraftDamageSystem<M = unknown> = DamageSystem<unit, M, WarcraftDamageOptions, WarcraftDamageDetail>;

/** Warcraft 1.31+ damage event adapter. Creating this object allocates no handles. */
export class WarcraftDamagePort implements DamagePort<unit, WarcraftDamageOptions, WarcraftDamageDetail> {
  private subscribed = false;

  public subscribe(handlers: Parameters<DamagePort<unit, WarcraftDamageOptions, WarcraftDamageDetail>["subscribe"]>[0]): () => void {
    if (this.subscribed) throw new Error("Warcraft damage port already subscribed");
    this.subscribed = true;
    let damaging: trigger | undefined;
    let damaged: trigger | undefined;
    let turnTimer: timer | undefined;
    let scheduled = false;
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      this.subscribed = false;
      if (damaging) DestroyTrigger(damaging);
      if (damaged) DestroyTrigger(damaged);
      if (turnTimer) { PauseTimer(turnTimer); DestroyTimer(turnTimer); }
    };

    const deliver = (callback: typeof handlers.damaging) => {
      if (closed) return;
      // The zero-time timer is only a recovery boundary. It does not assert HP timing.
      if (!scheduled && turnTimer) {
        scheduled = true;
        TimerStart(turnTimer, 0, false, () => {
          scheduled = false;
          if (!closed) handlers.settled();
        });
      }
      const source = GetEventDamageSource();
      const target = BlzGetEventDamageTarget();
      if (!source || !target) return;
      callback({
        source, target, amount: GetEventDamage(), isAttack: BlzGetEventIsAttack(),
        detail: { attackType: BlzGetEventAttackType(), damageType: BlzGetEventDamageType(), weaponType: BlzGetEventWeaponType() },
      });
    };

    try {
      damaging = CreateTrigger();
      damaged = CreateTrigger();
      turnTimer = CreateTimer();
      for (let id = 0; id < bj_MAX_PLAYER_SLOTS; id++) {
        const player = Player(id);
        if (player === undefined) throw new Error("Could not resolve Warcraft player slot");
        if (!TriggerRegisterPlayerUnitEvent(damaging, player, EVENT_PLAYER_UNIT_DAMAGING)) {
          throw new Error("Could not register Warcraft DAMAGING event");
        }
        if (!TriggerRegisterPlayerUnitEvent(damaged, player, EVENT_PLAYER_UNIT_DAMAGED)) {
          throw new Error("Could not register Warcraft DAMAGED event");
        }
      }
      TriggerAddAction(damaging, () => deliver(handlers.damaging));
      TriggerAddAction(damaged, () => deliver(handlers.damaged));
      return close;
    } catch (error) { close(); throw error; }
  }

  /** Sets the current event's damage (`BlzSetEventDamage`). */
  public setAmount(amount: number): void { BlzSetEventDamage(amount); }

  public setDetail(detail: WarcraftDamageDetail): void {
    if (detail.attackType !== undefined) BlzSetEventAttackType(detail.attackType);
    if (detail.damageType !== undefined) BlzSetEventDamageType(detail.damageType);
    if (detail.weaponType !== undefined) BlzSetEventWeaponType(detail.weaponType);
  }

  /** Deals damage with `UnitDamageTarget`, using the request's Warcraft options. */
  public deal(request: DamageRequest<unit, unknown, WarcraftDamageOptions>): boolean {
    const options = request.options;
    return UnitDamageTarget(request.source, request.target, request.amount,
      options?.attack ?? false, options?.ranged ?? false,
      options?.attackType ?? ATTACK_TYPE_NORMAL,
      options?.damageType ?? DAMAGE_TYPE_NORMAL,
      options?.weaponType ?? WEAPON_TYPE_WHOKNOWS);
  }
}

/** Explicitly call start() after registering listeners. Metadata belongs to the caller. */
export function createWarcraftDamage<M = unknown>(options: DamageSystemOptions = {}): WarcraftDamageSystem<M> {
  return new DamageSystem<unit, M, WarcraftDamageOptions, WarcraftDamageDetail>(new WarcraftDamagePort(), options);
}

/**
 * Whether the context's current amount would kill its target, for use in afterArmor (the last
 * point where the amount can still change). 0.405 is Warcraft's death threshold. Heuristic:
 * later listeners, mana shield or native effects can still change the outcome.
 */
export function isLethal(context: { readonly target: unit; readonly amount: number }): boolean {
  return GetWidgetLife(context.target) - context.amount <= 0.405;
}
