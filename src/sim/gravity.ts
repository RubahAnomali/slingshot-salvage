import { Tuning } from './config';
import type { Planet } from './types';

const SOFT = 0.55;

/** Acceleration at a point from every planet (softened inverse-square). Writes into `out`. */
export function accelAt(planets: readonly Planet[], x: number, y: number, out: { x: number; y: number }): void {
  let ax = 0;
  let ay = 0;
  const g = Tuning.gravity;
  for (const p of planets) {
    const dx = p.x - x;
    const dy = p.y - y;
    const soft = SOFT * p.r;
    const d2 = dx * dx + dy * dy + soft * soft;
    const inv = (p.gm * g) / (d2 * Math.sqrt(d2));
    ax += dx * inv;
    ay += dy * inv;
  }
  out.x = ax;
  out.y = ay;
}

/** Magnitude of one planet's pull at distance d from its centre. */
export function pullAt(p: Planet, d: number): number {
  const soft = SOFT * p.r;
  const d2 = d * d + soft * soft;
  return (p.gm * Tuning.gravity * d) / (d2 * Math.sqrt(d2));
}

/** Distance from a planet at which its pull equals `a` (bisection; used for contour rings). */
export function radiusForPull(p: Planet, a: number): number {
  let lo = p.r * 0.2;
  let hi = p.r * 40;
  if (pullAt(p, lo) < a) return 0;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (pullAt(p, mid) > a) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Speed for a circular orbit around `p` at distance d, from the local pull. */
export function circularSpeed(p: Planet, d: number): number {
  return Math.sqrt(pullAt(p, d) * d);
}

/**
 * Ballistic prediction (gravity only) used for the trajectory ghost. Stops on planet impact.
 * Returns packed x,y pairs in `out` and the number of valid points.
 */
export function predictPath(
  planets: readonly Planet[],
  x: number,
  y: number,
  vx: number,
  vy: number,
  steps: number,
  dt: number,
  out: Float32Array,
): number {
  const a = { x: 0, y: 0 };
  let n = 0;
  for (let i = 0; i < steps; i++) {
    accelAt(planets, x, y, a);
    vx += a.x * dt;
    vy += a.y * dt;
    x += vx * dt;
    y += vy * dt;
    out[n * 2] = x;
    out[n * 2 + 1] = y;
    n++;
    for (const p of planets) {
      if (Math.hypot(p.x - x, p.y - y) < p.r) return n;
    }
  }
  return n;
}
