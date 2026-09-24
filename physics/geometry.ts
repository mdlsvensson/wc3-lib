export interface Point2 { x: number; y: number }
/** World coordinates; z is absolute world height, not height above terrain. */
export interface Point3 extends Point2 { z: number }

export function finite(value: number, name: string): void {
  // Range check, not just NaN self-comparison: in Warcraft's Lua NaN == NaN is TRUE (verified in game),
  // so NaN is not reliably detectable there. Inputs must be kept NaN-free at the source.
  if (value !== value || !(value >= -3.4e38 && value <= 3.4e38)) throw new Error(`${name} must be finite`);
}

export function nonnegative(value: number, name: string): void {
  finite(value, name);
  if (value < 0) throw new Error(`${name} must not be negative`);
}

export function positive(value: number, name: string): void {
  finite(value, name);
  if (value <= 0) throw new Error(`${name} must be positive`);
}

export function point2(point: Point2): void {
  finite(point.x, "x");
  finite(point.y, "y");
}

export function point3(point: Point3): void {
  point2(point);
  finite(point.z, "z");
}

export function interpolate(from: Point3, to: Point3, fraction: number): Point3 {
  return { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction, z: from.z + (to.z - from.z) * fraction };
}

export function length3(v: Point3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/**
 * Rotates velocity toward the direction of `toward` by at most maxAngle radians, keeping its speed.
 * Pure homing primitive: call it from a missile's steer callback with turnRate * dt.
 * A zero velocity stays zero, and a zero `toward` leaves velocity unchanged.
 */
export function turnToward(velocity: Point3, toward: Point3, maxAngle: number): Point3 {
  const speed = length3(velocity);
  const distance = length3(toward);
  if (distance === 0 || speed === 0) return { ...velocity };
  const vx = toward.x / distance, vy = toward.y / distance, vz = toward.z / distance;
  const ux = velocity.x / speed, uy = velocity.y / speed, uz = velocity.z / speed;
  const dot = Math.max(-1, Math.min(1, ux * vx + uy * vy + uz * vz));
  const angle = Math.acos(dot);
  if (angle <= maxAngle) return { x: vx * speed, y: vy * speed, z: vz * speed };
  // Rotate u toward v inside their common plane: w is the unit vector in that plane orthogonal to u.
  let wx = vx - ux * dot, wy = vy - uy * dot, wz = vz - uz * dot;
  let w = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (w < 1e-9) {
    // Target is directly behind: turn horizontally (left) for a deterministic choice of plane.
    wx = -uy; wy = ux; wz = 0;
    w = Math.sqrt(wx * wx + wy * wy);
    if (w < 1e-9) { wx = 1; wy = 0; w = 1; } // Moving straight up or down.
  }
  wx /= w; wy /= w; wz /= w;
  const cos = Math.cos(maxAngle), sin = Math.sin(maxAngle);
  return { x: (ux * cos + wx * sin) * speed, y: (uy * cos + wy * sin) * speed, z: (uz * cos + wz * sin) * speed };
}

/** Earliest segment/sphere contact fraction, including an initial overlap. */
export function segmentSphere(from: Point3, to: Point3, center: Point3, radius: number): number | undefined {
  const x = from.x - center.x;
  const y = from.y - center.y;
  const z = from.z - center.z;
  const c = x * x + y * y + z * z - radius * radius;
  if (c <= 0) return 0;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const a = dx * dx + dy * dy + dz * dz;
  if (a === 0) return undefined;
  const b = x * dx + y * dy + z * dz;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return undefined;
  const fraction = (-b - Math.sqrt(discriminant)) / a;
  return fraction >= 0 && fraction <= 1 ? fraction : undefined;
}
