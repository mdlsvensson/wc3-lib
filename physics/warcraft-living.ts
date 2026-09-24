/** Shared by the Warcraft physics adapters: the unit exists and is alive. */
export function living(target: unit): boolean {
  return GetUnitTypeId(target) !== 0 && GetWidgetLife(target) > 0.405 && !IsUnitType(target, UNIT_TYPE_DEAD);
}
