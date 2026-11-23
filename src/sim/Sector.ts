import { Rng } from '../core/math';
import { GRAVITY_K, MAX_SECTOR, WORLD_W, WORLD_H } from './config';
import { circularSpeed } from './gravity';
import type { Beacon, Planet } from './types';

export interface PodSpawn {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface SectorPlan {
  planets: Planet[];
  beacon: Beacon;
  pods: PodSpawn[];
  quota: number;
  mines: number;
  interceptors: number;
  leeches: number;
  name: string;
}

const NAMES = ['KESTREL', 'MARROW', 'TALLOW', 'VESPER', 'HALCYON'];
const PODS = [4, 4, 5, 6, 6];
const PLANETS = [3, 3, 4, 4, 5];
const MINES = [2, 3, 4, 4, 5];
const INTERCEPTORS = [0, 1, 2, 2, 3];
const LEECHES = [0, 1, 1, 2, 2];

const at = (arr: number[], n: number): number => arr[Math.min(n, MAX_SECTOR) - 1]!;

/**
 * Procedural sector layout. Planets are rejection-sampled with a minimum gap, the beacon sits clear of
 * every gravity well, and each pod is placed on a circular orbit around one planet, so the player has to
 * catch cargo that is already moving.
 */
export function generateSector(n: number, seed: number): SectorPlan {
  const rng = new Rng(seed * 9973 + n * 7919);
  const planets: Planet[] = [];
  const count = at(PLANETS, n);
  let guard = 0;
  while (planets.length < count && guard++ < 400) {
    const r = rng.range(48, 88);
    const x = rng.range(300, WORLD_W - 300);
    const y = rng.range(260, WORLD_H - 260);
    if (planets.every((p) => Math.hypot(p.x - x, p.y - y) > p.r + r + 340)) {
      planets.push({ x, y, r, gm: GRAVITY_K * r * r, name: `P-${String(planets.length + 1).padStart(2, '0')}` });
    }
  }

  let beacon: Beacon = { x: WORLD_W / 2, y: WORLD_H / 2, r: 90 };
  guard = 0;
  while (guard++ < 400) {
    const x = rng.range(300, WORLD_W - 300);
    const y = rng.range(260, WORLD_H - 260);
    if (planets.every((p) => Math.hypot(p.x - x, p.y - y) > p.r * 3.4 + 120)) {
      beacon = { x, y, r: 90 };
      break;
    }
  }

  const pods: PodSpawn[] = [];
  const podCount = at(PODS, n);
  for (let i = 0; i < podCount; i++) {
    const p = planets[i % planets.length]!;
    let placed = false;
    for (let tries = 0; tries < 30 && !placed; tries++) {
      const d = p.r * rng.range(1.9, 2.9);
      const a = rng.range(0, Math.PI * 2);
      const x = p.x + Math.cos(a) * d;
      const y = p.y + Math.sin(a) * d;
      if (x < 80 || y < 80 || x > WORLD_W - 80 || y > WORLD_H - 80) continue;
      if (planets.some((q) => q !== p && Math.hypot(q.x - x, q.y - y) < q.r * 2.2)) continue;
      if (Math.hypot(beacon.x - x, beacon.y - y) < 260) continue;
      const v = circularSpeed(p, d) * rng.range(0.92, 1.0);
      const dir = rng.sign();
      pods.push({ x, y, vx: -Math.sin(a) * v * dir, vy: Math.cos(a) * v * dir });
      placed = true;
    }
    if (!placed) {
      const p0 = planets[0]!;
      pods.push({ x: p0.x + p0.r * 3, y: p0.y, vx: 0, vy: circularSpeed(p0, p0.r * 3) });
    }
  }

  return {
    planets,
    beacon,
    pods,
    quota: pods.length - Math.floor(pods.length * 0.3),
    mines: at(MINES, n),
    interceptors: at(INTERCEPTORS, n),
    leeches: at(LEECHES, n),
    name: NAMES[Math.min(n, MAX_SECTOR) - 1]!,
  };
}
