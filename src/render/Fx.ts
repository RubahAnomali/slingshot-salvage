import type { EventBus } from '../core/EventBus';
import { clamp, TAU } from '../core/math';
import { ObjectPool } from '../core/ObjectPool';
import type { SimEvents } from '../sim/types';
import { PAL } from './Palette';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  /** 0 = streak, 1 = expanding ring, 2 = dot */
  kind: 0 | 1 | 2;
  color: string;
  drag: number;
}

export interface Floater {
  x: number;
  y: number;
  text: string;
  life: number;
  color: string;
}

/**
 * Presentation-side reactions to sim events: particles, floating tags, screen-shake trauma and
 * hit-stop requests. The sim never sees any of this.
 */
export class Fx {
  readonly pool = new ObjectPool<Particle>(
    () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 1, kind: 2, color: PAL.ink, drag: 0 }),
    (p) => {
      p.drag = 0;
    },
    300,
  );
  readonly live: Particle[] = [];
  readonly floaters: Floater[] = [];
  /** 0..1, decays linearly; shake amplitude is trauma squared. */
  trauma = 0;
  /** Seconds of freeze requested since the last read. */
  private pendingStop = 0;
  private readonly off: (() => void)[] = [];

  constructor(bus: EventBus<SimEvents>) {
    const on = <K extends keyof SimEvents>(k: K, f: (p: SimEvents[K]) => void): void => {
      this.off.push(bus.on(k, f));
    };
    on('SHOT', (e) => {
      this.sparks(e.x, e.y, 3, 70, 0.14, e.hostile ? PAL.warn : PAL.ink, e.a, 0.9);
      this.addTrauma(e.hostile ? 0.05 : 0.04);
    });
    on('HIT', (e) => {
      this.sparks(e.x, e.y, 8, 190, 0.35, e.kind === 'ship' ? PAL.warn : PAL.ink);
      if (e.kind === 'ship') {
        this.addTrauma(0.3 + e.dmg * 0.012);
        this.stop(0.05 + Math.min(e.dmg, 40) * 0.0015);
      } else this.stop(0.025);
    });
    on('IMPACT', (e) => this.sparks(e.x, e.y, 4, 120, 0.25, PAL.dim));
    on('EXPLOSION', (e) => {
      this.ring(e.x, e.y, e.r, 0.5, PAL.warn);
      this.ring(e.x, e.y, e.r * 0.55, 0.35, PAL.ink);
      this.sparks(e.x, e.y, 26, 320, 0.7, PAL.warn);
      this.dots(e.x, e.y, 10, 90, 0.9, PAL.dim);
      this.addTrauma(clamp(e.r / 150, 0.3, 0.8));
      this.stop(0.07);
    });
    on('CRASH', (e) => {
      this.sparks(e.x, e.y, 14, 240, 0.5, PAL.ink);
      this.addTrauma(0.35 + e.damage * 0.01);
    });
    on('BURN', (e) => {
      this.sparks(e.x, e.y, 14, 380, 0.4, PAL.gold, e.a + Math.PI, 0.5);
      this.addTrauma(0.12);
    });
    on('POD_GRAB', (e) => this.ring(e.x, e.y, 34, 0.3, PAL.gold));
    on('POD_RELEASE', (e) => this.ring(e.x, e.y, 24, 0.25, PAL.dim));
    on('POD_DELIVER', (e) => {
      this.ring(e.x, e.y, 80, 0.5, PAL.gold);
      this.sparks(e.x, e.y, 14, 160, 0.6, PAL.gold);
      this.floaters.push({ x: e.x, y: e.y - 20, text: '+100', life: 1.2, color: PAL.gold });
    });
    on('POD_LOST', (e) => {
      this.ring(e.x, e.y, 50, 0.4, PAL.warn);
      this.floaters.push({ x: e.x, y: e.y - 16, text: 'CARGO LOST', life: 1.4, color: PAL.warn });
    });
    on('ENEMY_DOWN', (e) => {
      this.sparks(e.x, e.y, 16, 240, 0.55, PAL.warn);
      this.ring(e.x, e.y, 36, 0.3, PAL.ink);
      if (e.kind !== 'mine') {
        this.addTrauma(0.2);
        this.stop(0.05);
        this.floaters.push({ x: e.x, y: e.y - 16, text: '+25', life: 0.9, color: PAL.ink });
      }
    });
    on('WARN', (e) => this.ring(e.x, e.y, 60, 0.35, PAL.warn));
    on('DOCK', (e) => {
      if (e.on) this.addTrauma(0.05);
    });
  }

  dispose(): void {
    for (const o of this.off) o();
    this.off.length = 0;
  }

  addTrauma(a: number): void {
    this.trauma = clamp(this.trauma + a, 0, 1);
  }

  stop(sec: number): void {
    this.pendingStop = Math.max(this.pendingStop, sec);
  }

  /** Hit-stop requested since last call (seconds). */
  takeHitStop(): number {
    const s = this.pendingStop;
    this.pendingStop = 0;
    return s;
  }

  private spawn(x: number, y: number, vx: number, vy: number, life: number, size: number, kind: 0 | 1 | 2, color: string, drag: number): void {
    const p = this.pool.acquire();
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.life = p.max = life;
    p.size = size;
    p.kind = kind;
    p.color = color;
    p.drag = drag;
    this.live.push(p);
  }

  sparks(x: number, y: number, n: number, speed: number, life: number, color: string, dir?: number, spread = TAU): void {
    for (let i = 0; i < n; i++) {
      const a = (dir ?? 0) + (Math.random() - 0.5) * (dir === undefined ? TAU : spread);
      const s = speed * (0.35 + Math.random() * 0.65);
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s, life * (0.5 + Math.random() * 0.5), 1 + Math.random() * 2, 0, color, 2.5);
    }
  }

  dots(x: number, y: number, n: number, speed: number, life: number, color: string): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const s = speed * Math.random();
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s, life * (0.6 + Math.random() * 0.4), 2 + Math.random() * 3, 2, color, 1.5);
    }
  }

  ring(x: number, y: number, r: number, life: number, color: string): void {
    this.spawn(x, y, 0, 0, life, r, 1, color, 0);
  }

  exhaust(x: number, y: number, a: number, vx: number, vy: number): void {
    const back = a + Math.PI + (Math.random() - 0.5) * 0.35;
    const s = 120 + Math.random() * 90;
    this.spawn(x, y, vx * 0.6 + Math.cos(back) * s, vy * 0.6 + Math.sin(back) * s, 0.35, 1.5 + Math.random() * 1.5, 2, PAL.gold, 2);
  }

  update(dt: number): void {
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        this.live[i] = this.live[this.live.length - 1]!;
        this.live.pop();
        this.pool.release(p);
        continue;
      }
      if (p.drag > 0) {
        const k = Math.exp(-p.drag * dt);
        p.vx *= k;
        p.vy *= k;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i]!;
      f.life -= dt;
      f.y -= 26 * dt;
      if (f.life <= 0) this.floaters.splice(i, 1);
    }
  }

  clear(): void {
    for (const p of this.live) this.pool.release(p);
    this.live.length = 0;
    this.floaters.length = 0;
    this.trauma = 0;
    this.pendingStop = 0;
  }
}
