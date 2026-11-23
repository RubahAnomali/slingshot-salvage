import { angleDiff, clamp, TAU } from '../core/math';
import { INTERCEPTOR, MINE, SHIP, WORLD_H, WORLD_W } from '../sim/config';
import { predictPath, radiusForPull } from '../sim/gravity';
import type { Sim } from '../sim/World';
import type { Planet, Transform } from '../sim/types';
import type { Fx } from './Fx';
import { FONT_MONO, PAL } from './Palette';

export const VIEW_W = 1280;
export const VIEW_H = 720;

export interface DebugFlags {
  on: boolean;
  hitboxes: boolean;
  vectors: boolean;
  grid: boolean;
  labels: boolean;
}

/**
 * Canvas renderer. Reads the sim (never writes it) and draws a cyanotype blueprint: flat paper colour,
 * thin ink lines, dashed construction geometry and two spot inks.
 */
export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  private scale = 1;
  private offX = 0;
  private offY = 0;
  private dpr = 1;
  camX = WORLD_W / 2;
  camY = WORLD_H / 2;
  zoom = 1;
  private readonly path = new Float32Array(2 * 120);
  private shakeX = 0;
  private shakeY = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  // ---- frame plumbing ---------------------------------------------------------------------------

  begin(): CanvasRenderingContext2D {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
    this.scale = Math.min(w / VIEW_W, h / VIEW_H);
    this.offX = (w - VIEW_W * this.scale) / 2;
    this.offY = (h - VIEW_H * this.scale) / 2;
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#0a1f38';
    c.fillRect(0, 0, w, h);
    c.setTransform(this.scale, 0, 0, this.scale, this.offX, this.offY);
    c.beginPath();
    c.rect(0, 0, VIEW_W, VIEW_H);
    c.clip();
    return c;
  }

  toLogical(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((clientX - r.left) * this.dpr - this.offX) / this.scale,
      y: ((clientY - r.top) * this.dpr - this.offY) / this.scale,
    };
  }

  // ---- camera -----------------------------------------------------------------------------------

  updateCamera(sim: Sim, alpha: number, dt: number, fx: Fx): void {
    const st = sim.tf.get(sim.ship);
    const sb = sim.body.get(sim.ship);
    if (!st || !sb) return;
    const x = st.px + (st.x - st.px) * alpha;
    const y = st.py + (st.y - st.py) * alpha;
    const tx = x + sb.vx * 0.38;
    const ty = y + sb.vy * 0.38;
    const k = 1 - Math.exp(-5 * dt);
    this.camX += (tx - this.camX) * k;
    this.camY += (ty - this.camY) * k;
    const speed = Math.hypot(sb.vx, sb.vy);
    const tz = 1 - clamp(speed / 700, 0, 0.22);
    this.zoom += (tz - this.zoom) * (1 - Math.exp(-2.5 * dt));
    const amp = fx.trauma * fx.trauma * 22;
    const n = performance.now() * 0.05;
    this.shakeX = amp * (Math.sin(n * 1.7) + Math.sin(n * 3.1) * 0.5);
    this.shakeY = amp * (Math.cos(n * 2.3) + Math.sin(n * 2.9) * 0.5);
  }

  snapCamera(sim: Sim): void {
    const st = sim.tf.get(sim.ship);
    if (st) {
      this.camX = st.x;
      this.camY = st.y;
    }
    this.zoom = 1;
  }

  private sx(wx: number): number {
    return (wx - this.camX) * this.zoom + VIEW_W / 2 + this.shakeX;
  }
  private sy(wy: number): number {
    return (wy - this.camY) * this.zoom + VIEW_H / 2 + this.shakeY;
  }

  // ---- world pass -------------------------------------------------------------------------------

  drawWorld(sim: Sim, fx: Fx, alpha: number, time: number, dbg: DebugFlags): void {
    const c = this.ctx;
    c.fillStyle = PAL.paper;
    c.fillRect(0, 0, VIEW_W, VIEW_H);

    c.save();
    c.translate(VIEW_W / 2 + this.shakeX, VIEW_H / 2 + this.shakeY);
    c.scale(this.zoom, this.zoom);
    c.translate(-this.camX, -this.camY);

    const hw = VIEW_W / 2 / this.zoom + 40;
    const hh = VIEW_H / 2 / this.zoom + 40;
    const vx0 = this.camX - hw;
    const vx1 = this.camX + hw;
    const vy0 = this.camY - hh;
    const vy1 = this.camY + hh;

    this.drawGrid(vx0, vx1, vy0, vy1);
    for (const p of sim.planets) this.drawPlanet(p, time);
    this.drawBeacon(sim, time);

    // Predicted trajectory under gravity alone.
    const sc = sim.shipC;
    const stf = sim.tf.get(sim.ship)!;
    const sbd = sim.body.get(sim.ship)!;
    const live = sc.fsm.state !== 'Dead';
    if (live && sc.fsm.state !== 'Docked') {
      const x = stf.px + (stf.x - stf.px) * alpha;
      const y = stf.py + (stf.y - stf.py) * alpha;
      this.drawPath(sim, x, y, sbd.vx, sbd.vy);
    }

    this.drawPods(sim, alpha, time);
    this.drawEnemies(sim, alpha, time);
    this.drawBolts(sim, alpha);
    if (live) this.drawShip(sim, alpha, time);
    this.drawParticles(fx);

    if (dbg.on) this.drawDebugWorld(sim, alpha, dbg);
    c.restore();

    // Floating text in screen space (crisper than scaled text).
    c.textAlign = 'center';
    c.font = `bold 15px ${FONT_MONO}`;
    for (const f of fx.floaters) {
      c.globalAlpha = clamp(f.life * 1.6, 0, 1);
      c.fillStyle = f.color;
      c.fillText(f.text, this.sx(f.x), this.sy(f.y));
    }
    c.globalAlpha = 1;
    this.drawOffscreen(sim, alpha);
  }

  private drawGrid(x0: number, x1: number, y0: number, y1: number): void {
    const c = this.ctx;
    const minor = 100;
    const major = 500;
    c.lineWidth = 1 / this.zoom;
    c.strokeStyle = PAL.gridMinor;
    c.beginPath();
    for (let x = Math.max(0, Math.floor(x0 / minor) * minor); x <= Math.min(WORLD_W, x1); x += minor) {
      if (x % major === 0) continue;
      c.moveTo(x, Math.max(0, y0));
      c.lineTo(x, Math.min(WORLD_H, y1));
    }
    for (let y = Math.max(0, Math.floor(y0 / minor) * minor); y <= Math.min(WORLD_H, y1); y += minor) {
      if (y % major === 0) continue;
      c.moveTo(Math.max(0, x0), y);
      c.lineTo(Math.min(WORLD_W, x1), y);
    }
    c.stroke();
    c.strokeStyle = PAL.gridMajor;
    c.lineWidth = 1.5 / this.zoom;
    c.beginPath();
    for (let x = 0; x <= WORLD_W; x += major) {
      c.moveTo(x, 0);
      c.lineTo(x, WORLD_H);
    }
    for (let y = 0; y <= WORLD_H; y += major) {
      c.moveTo(0, y);
      c.lineTo(WORLD_W, y);
    }
    c.stroke();
    c.font = `${11 / this.zoom}px ${FONT_MONO}`;
    c.fillStyle = PAL.gridMajor;
    c.textAlign = 'left';
    for (let x = 0; x <= WORLD_W; x += major) {
      for (let y = 0; y <= WORLD_H; y += major) {
        if (x < x0 - 60 || x > x1 || y < y0 - 20 || y > y1) continue;
        c.fillText(`${x},${y}`, x + 4, y + 13 / this.zoom);
      }
    }
    // Sheet border with corner ticks.
    c.strokeStyle = PAL.dim;
    c.lineWidth = 3 / this.zoom;
    c.strokeRect(0, 0, WORLD_W, WORLD_H);
  }

  private drawPlanet(p: Planet, time: number): void {
    const c = this.ctx;
    const z = 1 / this.zoom;
    // Equal-pull contours.
    c.font = `${11 * z}px ${FONT_MONO}`;
    c.textAlign = 'left';
    for (const a of [22, 55, 120]) {
      const r = radiusForPull(p, a);
      if (r <= p.r + 6) continue;
      c.setLineDash([6 * z, 8 * z]);
      c.strokeStyle = PAL.dim;
      c.globalAlpha = 0.55;
      c.lineWidth = 1 * z;
      c.beginPath();
      c.arc(p.x, p.y, r, 0, TAU);
      c.stroke();
      c.globalAlpha = 0.8;
      c.fillStyle = PAL.dim;
      c.fillText(`g=${a}`, p.x + r * 0.7071 + 4, p.y - r * 0.7071);
    }
    c.setLineDash([]);
    c.globalAlpha = 1;

    c.fillStyle = PAL.paperDeep;
    c.beginPath();
    c.arc(p.x, p.y, p.r, 0, TAU);
    c.fill();
    c.save();
    c.beginPath();
    c.arc(p.x, p.y, p.r, 0, TAU);
    c.clip();
    c.strokeStyle = PAL.dim;
    c.globalAlpha = 0.4;
    c.lineWidth = 1 * z;
    c.beginPath();
    for (let o = -p.r * 2; o < p.r * 2; o += 9) {
      c.moveTo(p.x + o - p.r, p.y + p.r);
      c.lineTo(p.x + o + p.r, p.y - p.r);
    }
    c.stroke();
    c.restore();
    c.globalAlpha = 1;
    c.strokeStyle = PAL.ink;
    c.lineWidth = 2.5 * z;
    c.beginPath();
    c.arc(p.x, p.y, p.r, 0, TAU);
    c.stroke();
    // Slow rotating tick ring reads as a rotating body without any glow tricks.
    c.lineWidth = 1 * z;
    c.strokeStyle = PAL.ink;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU + time * 0.05;
      c.beginPath();
      c.moveTo(p.x + Math.cos(a) * (p.r + 3), p.y + Math.sin(a) * (p.r + 3));
      c.lineTo(p.x + Math.cos(a) * (p.r + (i % 6 === 0 ? 12 : 7)), p.y + Math.sin(a) * (p.r + (i % 6 === 0 ? 12 : 7)));
      c.stroke();
    }
    c.font = `bold ${13 * z}px ${FONT_MONO}`;
    c.textAlign = 'center';
    c.fillStyle = PAL.ink;
    c.fillText(p.name, p.x, p.y - 2 * z);
    c.font = `${10 * z}px ${FONT_MONO}`;
    c.fillStyle = PAL.dim;
    c.fillText(`R ${Math.round(p.r)}`, p.x, p.y + 12 * z);
  }

  private drawBeacon(sim: Sim, time: number): void {
    const c = this.ctx;
    const b = sim.beacon;
    const z = 1 / this.zoom;
    c.strokeStyle = PAL.gold;
    c.lineWidth = 2 * z;
    c.setLineDash([14 * z, 8 * z]);
    c.lineDashOffset = -time * 14;
    c.beginPath();
    c.arc(b.x, b.y, b.r, 0, TAU);
    c.stroke();
    c.setLineDash([3 * z, 6 * z]);
    c.lineWidth = 1 * z;
    c.beginPath();
    c.arc(b.x, b.y, b.r * 0.85, 0, TAU);
    c.stroke();
    c.setLineDash([]);
    c.lineDashOffset = 0;
    c.lineWidth = 1.5 * z;
    c.beginPath();
    c.moveTo(b.x - 14, b.y);
    c.lineTo(b.x + 14, b.y);
    c.moveTo(b.x, b.y - 14);
    c.lineTo(b.x, b.y + 14);
    c.stroke();
    c.beginPath();
    c.rect(b.x - 8, b.y - 8, 16, 16);
    c.stroke();
    c.font = `bold ${12 * z}px ${FONT_MONO}`;
    c.textAlign = 'center';
    c.fillStyle = PAL.gold;
    c.fillText('DROP ZONE', b.x, b.y - b.r - 10 * z);
    c.font = `${10 * z}px ${FONT_MONO}`;
    c.fillText(`${sim.podsDelivered}/${sim.quota} DELIVERED`, b.x, b.y + b.r + 16 * z);
  }

  private drawPath(sim: Sim, x: number, y: number, vx: number, vy: number): void {
    const c = this.ctx;
    const steps = 110;
    const n = predictPath(sim.planets, x, y, vx, vy, steps, 1 / 30, this.path);
    const z = 1 / this.zoom;
    c.strokeStyle = PAL.ink;
    c.lineWidth = 1.5 * z;
    c.setLineDash([2 * z, 7 * z]);
    c.globalAlpha = 0.75;
    c.beginPath();
    c.moveTo(x, y);
    for (let i = 0; i < n; i++) c.lineTo(this.path[i * 2]!, this.path[i * 2 + 1]!);
    c.stroke();
    c.setLineDash([]);
    c.globalAlpha = 0.9;
    c.fillStyle = PAL.ink;
    for (let i = 14; i < n; i += 15) {
      c.beginPath();
      c.arc(this.path[i * 2]!, this.path[i * 2 + 1]!, 2.4 * z, 0, TAU);
      c.fill();
    }
    if (n < steps) {
      const ex = this.path[(n - 1) * 2]!;
      const ey = this.path[(n - 1) * 2 + 1]!;
      c.strokeStyle = PAL.warn;
      c.lineWidth = 2 * z;
      c.beginPath();
      c.moveTo(ex - 7 * z, ey - 7 * z);
      c.lineTo(ex + 7 * z, ey + 7 * z);
      c.moveTo(ex + 7 * z, ey - 7 * z);
      c.lineTo(ex - 7 * z, ey + 7 * z);
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  private ix(t: Transform, a: number): number {
    return t.px + (t.x - t.px) * a;
  }
  private iy(t: Transform, a: number): number {
    return t.py + (t.y - t.py) * a;
  }
  private ia(t: Transform, a: number): number {
    return t.pa + angleDiff(t.pa, t.a) * a;
  }

  private drawPods(sim: Sim, alpha: number, time: number): void {
    const c = this.ctx;
    const z = 1 / this.zoom;
    // Tether first, so pods draw over it.
    c.strokeStyle = PAL.gold;
    c.lineWidth = 1.5 * z;
    c.setLineDash([5 * z, 4 * z]);
    for (const pe of sim.chain) {
      const pc = sim.pod.get(pe);
      if (!pc) continue;
      const a = sim.tf.get(pc.link);
      const p = sim.tf.get(pe);
      if (!a || !p) continue;
      c.beginPath();
      c.moveTo(this.ix(a, alpha), this.iy(a, alpha));
      c.lineTo(this.ix(p, alpha), this.iy(p, alpha));
      c.stroke();
    }
    c.setLineDash([]);
    for (const [e, pc] of sim.pod) {
      const t = sim.tf.get(e)!;
      const x = this.ix(t, alpha);
      const y = this.iy(t, alpha);
      const r = 11;
      c.save();
      c.translate(x, y);
      c.rotate(time * 0.6 + e);
      c.fillStyle = PAL.paper;
      c.strokeStyle = pc.mode === 'carried' ? PAL.warn : PAL.gold;
      c.lineWidth = 2 * z;
      c.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        const px = Math.cos(a) * r;
        const py = Math.sin(a) * r;
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.closePath();
      c.fill();
      c.stroke();
      c.lineWidth = 1.2 * z;
      c.beginPath();
      c.moveTo(-5, 0);
      c.lineTo(5, 0);
      c.moveTo(0, -5);
      c.lineTo(0, 5);
      c.stroke();
      c.restore();
    }
  }

  private drawEnemies(sim: Sim, alpha: number, time: number): void {
    const c = this.ctx;
    const z = 1 / this.zoom;
    for (const [e, k] of sim.kind) {
      if (k !== 'mine' && k !== 'interceptor' && k !== 'leech') continue;
      const t = sim.tf.get(e)!;
      const h = sim.health.get(e)!;
      const br = sim.brain.get(e)!;
      const x = this.ix(t, alpha);
      const y = this.iy(t, alpha);
      const a = this.ia(t, alpha);
      const flash = h.flash > 0;
      c.save();
      c.translate(x, y);
      c.lineWidth = 2 * z;
      c.strokeStyle = flash ? PAL.ink : PAL.warn;
      c.fillStyle = flash ? PAL.ink : PAL.paper;

      if (k === 'mine') {
        const m = sim.mine.get(e)!;
        const armed = br.fsm.state === 'Armed';
        c.rotate(a);
        c.beginPath();
        c.arc(0, 0, MINE.radius, 0, TAU);
        c.fill();
        c.stroke();
        c.beginPath();
        for (let i = 0; i < 8; i++) {
          const an = (i / 8) * TAU;
          c.moveTo(Math.cos(an) * MINE.radius, Math.sin(an) * MINE.radius);
          c.lineTo(Math.cos(an) * (MINE.radius + 7), Math.sin(an) * (MINE.radius + 7));
        }
        c.stroke();
        c.fillStyle = armed && Math.floor(time * 12) % 2 === 0 ? PAL.ink : PAL.warn;
        c.beginPath();
        c.arc(0, 0, 4, 0, TAU);
        c.fill();
        c.rotate(-a);
        if (armed) {
          // Blast footprint plus a collapsing ring: when it reaches the centre, it goes off.
          c.setLineDash([7 * z, 6 * z]);
          c.lineWidth = 1.5 * z;
          c.beginPath();
          c.arc(0, 0, MINE.blast, 0, TAU);
          c.stroke();
          c.setLineDash([]);
          c.lineWidth = 2.5 * z;
          c.beginPath();
          c.arc(0, 0, Math.max(2, MINE.blast * (m.fuse / MINE.fuse)), 0, TAU);
          c.stroke();
        }
      } else if (k === 'interceptor') {
        c.rotate(a);
        c.beginPath();
        c.moveTo(20, 0);
        c.lineTo(-12, -13);
        c.lineTo(-5, 0);
        c.lineTo(-12, 13);
        c.closePath();
        c.fill();
        c.stroke();
        c.beginPath();
        c.moveTo(-5, 0);
        c.lineTo(8, 0);
        c.stroke();
        c.rotate(-a);
        const st = br.fsm.state;
        if (st === 'Charge' || st === 'Fire') {
          const locked = st === 'Fire' || br.fsm.time >= INTERCEPTOR.charge - INTERCEPTOR.lockTime;
          const len = 820;
          c.strokeStyle = PAL.warn;
          c.lineWidth = (locked ? 2.5 : 1.2) * z;
          c.setLineDash(locked ? [] : [10 * z, 8 * z]);
          c.globalAlpha = locked ? 0.95 : 0.7;
          c.beginPath();
          c.moveTo(Math.cos(br.lockedA) * 22, Math.sin(br.lockedA) * 22);
          c.lineTo(Math.cos(br.lockedA) * len, Math.sin(br.lockedA) * len);
          c.stroke();
          c.setLineDash([]);
          c.globalAlpha = 1;
          // Charge ring closes in.
          const f = st === 'Charge' ? 1 - br.fsm.time / INTERCEPTOR.charge : 0;
          c.beginPath();
          c.arc(0, 0, 18 + 30 * f, 0, TAU);
          c.stroke();
        }
      } else {
        // Leech: a hooked crescent with a grasping prong.
        c.rotate(a);
        c.beginPath();
        c.arc(0, 0, 13, -2.4, 2.4);
        c.lineTo(10, 0);
        c.closePath();
        c.fill();
        c.stroke();
        c.beginPath();
        c.moveTo(13, 0);
        c.lineTo(22, 0);
        c.stroke();
        c.rotate(-a);
      }
      if (h.max > 1 && h.hp < h.max) {
        c.fillStyle = PAL.warn;
        for (let i = 0; i < h.hp; i++) c.fillRect(-9 + i * 8, 24, 6, 3);
      }
      c.restore();
    }
  }

  private drawBolts(sim: Sim, alpha: number): void {
    const c = this.ctx;
    const z = 1 / this.zoom;
    for (const [e, bc] of sim.bolt) {
      const t = sim.tf.get(e)!;
      const b = sim.body.get(e)!;
      const x = this.ix(t, alpha);
      const y = this.iy(t, alpha);
      const sp = Math.hypot(b.vx, b.vy) || 1;
      const len = bc.hostile ? 16 : 13;
      c.strokeStyle = bc.hostile ? PAL.warn : PAL.ink;
      c.lineWidth = (bc.hostile ? 3.5 : 2.5) * z;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x - (b.vx / sp) * len, y - (b.vy / sp) * len);
      c.stroke();
    }
    c.lineCap = 'butt';
  }

  private drawShip(sim: Sim, alpha: number, time: number): void {
    const c = this.ctx;
    const z = 1 / this.zoom;
    const s = sim.shipC;
    const t = sim.tf.get(sim.ship)!;
    const x = this.ix(t, alpha);
    const y = this.iy(t, alpha);
    const a = this.ia(t, alpha);
    const st = s.fsm.state;
    if (s.invuln > 0 && Math.floor(time * 18) % 2 === 0) return;
    c.save();
    c.translate(x, y);
    c.rotate(a);
    // Squash and stretch on the burn.
    if (st === 'Burn') c.scale(1.35, 0.8);
    else if (st === 'Stunned') c.scale(0.92, 1.08);
    if (st === 'Thrust' || st === 'Burn') {
      const fl = st === 'Burn' ? 34 : 14 + Math.random() * 10;
      c.strokeStyle = PAL.gold;
      c.lineWidth = 2 * z;
      c.beginPath();
      c.moveTo(-9, -5);
      c.lineTo(-9 - fl, 0);
      c.lineTo(-9, 5);
      c.moveTo(-9, 0);
      c.lineTo(-9 - fl * 0.7, 0);
      c.stroke();
    }
    c.fillStyle = sim.health.get(sim.ship)!.flash > 0 ? PAL.ink : PAL.paper;
    c.strokeStyle = PAL.ink;
    c.lineWidth = 2.2 * z;
    if (st === 'Stunned') c.setLineDash([4 * z, 3 * z]);
    c.beginPath();
    c.moveTo(18, 0);
    c.lineTo(-12, -11);
    c.lineTo(-7, 0);
    c.lineTo(-12, 11);
    c.closePath();
    c.fill();
    c.stroke();
    c.setLineDash([]);
    c.lineWidth = 1.2 * z;
    c.beginPath();
    c.moveTo(-7, 0);
    c.lineTo(10, 0);
    c.stroke();
    c.restore();
    if (st === 'Docked') {
      c.strokeStyle = PAL.gold;
      c.lineWidth = 1.5 * z;
      c.beginPath();
      c.arc(x, y, SHIP.radius + 9 + Math.sin(time * 5) * 2, 0, TAU);
      c.stroke();
    }
  }

  private drawParticles(fx: Fx): void {
    const c = this.ctx;
    const z = 1 / this.zoom;
    for (const p of fx.live) {
      const f = clamp(p.life / p.max, 0, 1);
      c.globalAlpha = f;
      c.strokeStyle = p.color;
      c.fillStyle = p.color;
      if (p.kind === 0) {
        c.lineWidth = p.size * z;
        c.beginPath();
        c.moveTo(p.x, p.y);
        c.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04);
        c.stroke();
      } else if (p.kind === 1) {
        c.lineWidth = 2 * z;
        c.beginPath();
        c.arc(p.x, p.y, p.size * (1 - f * f), 0, TAU);
        c.stroke();
      } else {
        c.beginPath();
        c.arc(p.x, p.y, p.size * f, 0, TAU);
        c.fill();
      }
    }
    c.globalAlpha = 1;
  }

  /** Edge arrows for things outside the view. */
  private drawOffscreen(sim: Sim, alpha: number): void {
    const c = this.ctx;
    const inset = 28;
    const mark = (wx: number, wy: number, color: string, label: string): void => {
      const x = this.sx(wx);
      const y = this.sy(wy);
      if (x > 0 && x < VIEW_W && y > 0 && y < VIEW_H) return;
      const cx = VIEW_W / 2;
      const cy = VIEW_H / 2;
      const dx = x - cx;
      const dy = y - cy;
      const limY = dy < 0 ? cy - 100 : cy - 64;
      const k = Math.min((cx - inset) / Math.abs(dx || 1e-6), limY / Math.abs(dy || 1e-6));
      const px = cx + dx * k;
      const py = cy + dy * k;
      const a = Math.atan2(dy, dx);
      c.save();
      c.translate(px, py);
      c.rotate(a);
      c.fillStyle = color;
      c.beginPath();
      c.moveTo(9, 0);
      c.lineTo(-6, -6);
      c.lineTo(-6, 6);
      c.closePath();
      c.fill();
      c.restore();
      c.font = `10px ${FONT_MONO}`;
      c.textAlign = 'center';
      c.fillStyle = color;
      c.fillText(label, px - Math.cos(a) * 22, py - Math.sin(a) * 22 + 3);
    };
    const st = sim.tf.get(sim.ship)!;
    const sx0 = this.ix(st, alpha);
    const sy0 = this.iy(st, alpha);
    mark(sim.beacon.x, sim.beacon.y, PAL.gold, `DROP ${Math.round(Math.hypot(sim.beacon.x - sx0, sim.beacon.y - sy0) / 10)}`);
    for (const [e, pc] of sim.pod) {
      if (pc.mode !== 'free') continue;
      const t = sim.tf.get(e)!;
      mark(this.ix(t, alpha), this.iy(t, alpha), PAL.gold, 'POD');
    }
    for (const [e, br] of sim.brain) {
      if (sim.kind.get(e) !== 'interceptor') continue;
      const s = br.fsm.state;
      if (s !== 'Charge' && s !== 'Fire') continue;
      const t = sim.tf.get(e)!;
      mark(this.ix(t, alpha), this.iy(t, alpha), PAL.warn, '!');
    }
  }

  // ---- debug (world space) ----------------------------------------------------------------------

  private drawDebugWorld(sim: Sim, alpha: number, dbg: DebugFlags): void {
    const c = this.ctx;
    const z = 1 / this.zoom;
    c.lineWidth = 1 * z;
    if (dbg.grid) {
      c.strokeStyle = '#7bffb0';
      c.globalAlpha = 0.25;
      const cs = sim.hash.cellSize;
      c.beginPath();
      for (let x = 0; x <= WORLD_W; x += cs) {
        c.moveTo(x, 0);
        c.lineTo(x, WORLD_H);
      }
      for (let y = 0; y <= WORLD_H; y += cs) {
        c.moveTo(0, y);
        c.lineTo(WORLD_W, y);
      }
      c.stroke();
      c.globalAlpha = 1;
    }
    for (const [e, b] of sim.body) {
      const t = sim.tf.get(e)!;
      const x = this.ix(t, alpha);
      const y = this.iy(t, alpha);
      if (dbg.hitboxes) {
        c.strokeStyle = '#7bffb0';
        c.beginPath();
        c.arc(x, y, b.radius, 0, TAU);
        c.stroke();
      }
      if (dbg.vectors) {
        c.strokeStyle = '#ff5fd0';
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x + b.vx * 0.4, y + b.vy * 0.4);
        c.stroke();
      }
      if (dbg.labels) {
        const br = sim.brain.get(e);
        const label = br ? `${br.fsm.state}${br.note ? ' · ' + br.note : ''}` : e === sim.ship ? sim.shipC.fsm.state : '';
        if (label) {
          c.font = `${11 * z}px ${FONT_MONO}`;
          c.fillStyle = '#7bffb0';
          c.textAlign = 'center';
          c.fillText(label, x, y - b.radius - 10 * z);
        }
      }
    }
    if (dbg.hitboxes) {
      c.strokeStyle = '#7bffb0';
      c.setLineDash([4 * z, 4 * z]);
      for (const p of sim.planets) {
        c.beginPath();
        c.arc(p.x, p.y, p.r, 0, TAU);
        c.stroke();
      }
      c.beginPath();
      c.arc(sim.beacon.x, sim.beacon.y, sim.beacon.r * 0.85, 0, TAU);
      c.stroke();
      c.setLineDash([]);
    }
  }
}
