/**
 * `WarcraftTerrain`, terrain height sampling for missile ground collision.
 *
 * @example
 * ```ts
 * import { WarcraftTerrain } from "@mdlsvensson/wc3-lib/physics/warcraft-terrain";
 *
 * const terrain = new WarcraftTerrain();
 * const groundHeight = (x: number, y: number) => terrain.height(x, y);
 * // later: terrain.dispose();
 * ```
 *
 * @module
 */

/**
 * Terrain height sampling through one owned location (GetLocationZ has no x/y variant).
 * Explicitly constructed; dispose() removes the location. Heights can differ between clients
 * under async terrain deformation, so avoid deformation effects where ground collision matters.
 */
export class WarcraftTerrain {
  private location?: location;
  /** Absolute terrain height at (x, y). Creates the location on first use. */
  height(x: number, y: number): number {
    if (this.location === undefined) {
      // Cast: under `deno check` the DOM's Location class shadows the Warcraft Location() native.
      this.location = (Location as unknown as (x: number, y: number) => location | undefined)(x, y);
      if (this.location === undefined) throw new Error("Failed to create terrain sample location");
    } else MoveLocation(this.location, x, y);
    return GetLocationZ(this.location);
  }
  /** Removes the location. Idempotent; a later `height` call creates a new one. */
  dispose(): void {
    if (this.location !== undefined) RemoveLocation(this.location);
    this.location = undefined;
  }
}
