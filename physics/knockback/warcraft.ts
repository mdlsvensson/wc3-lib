import { point2, positive, type Point2 } from "../geometry.ts";
import { living } from "../warcraft-living.ts";
import type { KnockbackPort } from "./system.ts";

export interface WarcraftKnockbackOptions {
  /** Point sampling ignores footprints, units and destructibles. Custom policy may check those. */
  pathing: "unrestricted" | "terrain-point" | ((this: void, target: unit, from: Point2, to: Point2) => boolean);
  /** Maximum gap between terrain samples in world units; default 32. Moves over 4096 samples are blocked. */
  sampleStep?: number;
}

/** Sets x/y directly; never pauses/unpauses, changes orders, or changes unit pathing flags. */
export class WarcraftKnockbackPort implements KnockbackPort<unit> {
  private readonly options: WarcraftKnockbackOptions;
  constructor(options: WarcraftKnockbackOptions) {
    positive(options.sampleStep ?? 32, "sampleStep");
    this.options = { ...options };
  }

  valid(target: unit): boolean { return living(target); }
  position(target: unit): Point2 { return { x: GetUnitX(target), y: GetUnitY(target) }; }

  move(target: unit, to: Point2): boolean {
    point2(to);
    const from = this.position(target);
    const policy = this.options.pathing;
    if (typeof policy === "function") {
      if (!policy(target, from, to)) return false;
    } else if (policy === "terrain-point") {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const samples = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / (this.options.sampleStep ?? 32)));
      if (samples > 4096) return false;
      for (let sample = 1; sample <= samples; sample++) {
        if (IsTerrainPathable(from.x + dx * sample / samples, from.y + dy * sample / samples, PATHING_TYPE_WALKABILITY)) return false;
      }
    }
    SetUnitX(target, to.x);
    SetUnitY(target, to.y);
    return true;
  }
}
