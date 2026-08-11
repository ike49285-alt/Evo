// Shared math primitives used across the sim. No DOM dependency here so
// `sim/` stays headless-runnable (perf testing, balance tuning, etc.).

export interface Vec2 {
  x: number;
  y: number;
}

export function dist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Unit vector from `a` to `b`. Returns {x:0,y:0} if the points coincide. */
export function directionTo(a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 1e-9) return { x: 0, y: 0 };
  return { x: dx / d, y: dy / d };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Wraps an angle (radians) into (-PI, PI]. */
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}
