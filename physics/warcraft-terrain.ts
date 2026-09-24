/**
 * Terrain height sampling through one owned location (GetLocationZ has no x/y variant).
 * Explicitly constructed; dispose() removes the location. Heights can differ between clients
 * under async terrain deformation, so avoid deformation effects where ground collision matters.
 */
export class WarcraftTerrain {
  private location?: location;
  height(x: number, y: number): number {
    if (this.location === undefined) {
      // Cast: under `deno check` the DOM's Location class shadows the Warcraft Location() native.
      this.location = (Location as unknown as (x: number, y: number) => location | undefined)(x, y);
      if (this.location === undefined) throw new Error("Failed to create terrain sample location");
    } else MoveLocation(this.location, x, y);
    return GetLocationZ(this.location);
  }
  dispose(): void {
    if (this.location !== undefined) RemoveLocation(this.location);
    this.location = undefined;
  }
}
