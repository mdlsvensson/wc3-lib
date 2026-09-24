import { DummyManager, type DummyPort } from "./dummy.ts";
import { Scheduler } from "../core/scheduler.ts";

/** Caller supplies an object-data dummy with zero cast point and suitable movement/vision. */
export function createWarcraftDummies(clock: Scheduler): DummyManager<unit, player> {
  const port: DummyPort<unit, player> = {
    create: request => CreateUnit(request.owner, request.rawcode, request.x, request.y, request.facing ?? 0) ?? undefined,
    configure: (dummy, request) => {
      UnitAddAbility(dummy, FourCC("Aloc"));
      SetUnitInvulnerable(dummy, true);
      SetUnitPathing(dummy, false);
      if (!UnitAddAbility(dummy, request.ability) && GetUnitAbilityLevel(dummy, request.ability) === 0) {
        throw new Error("Dummy ability does not exist");
      }
      SetUnitAbilityLevel(dummy, request.ability, request.level ?? 1);
      SetUnitState(dummy, UNIT_STATE_MANA, GetUnitState(dummy, UNIT_STATE_MAX_MANA));
    },
    order: (dummy, request) => request.target !== undefined
      ? IssueTargetOrder(dummy, request.order, request.target)
      : request.point !== undefined
      ? IssuePointOrder(dummy, request.order, request.point.x, request.point.y)
      : IssueImmediateOrder(dummy, request.order),
    remove: dummy => RemoveUnit(dummy),
  };
  return new DummyManager(clock, port);
}
