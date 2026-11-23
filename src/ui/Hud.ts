import { TAU } from '../core/math';
import { FONT_HEAD, FONT_MONO, PAL } from '../render/Palette';
import { VIEW_H, VIEW_W } from '../render/Renderer';
import { MAX_SECTOR, SHIP, WORLD_H, WORLD_W } from '../sim/config';
import type { Sim } from '../sim/World';

export type Screen = 'title' | 'play' | 'paused';

interface Button {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const REASONS: Record<string, string> = {
  hull: 'HULL BREACH',
  stranded: 'STRANDED: FUEL EXHAUSTED',
  contract: 'CONTRACT UNREACHABLE: TOO MUCH CARGO LOST',
};

/** Canvas HUD, menus and the minimap, drawn in 1280x720 logical screen space. */
export class Hud {
  private buttons: Button[] = [];

  hit(x: number, y: number): string | null {
    for (const b of this.buttons) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.id;
    return null;
  }

  // ---- primitives -------------------------------------------------------------------------------

  private text(c: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left', head = false): void {
    c.font = head ? `bold ${size}px ${FONT_HEAD}` : `${size}px ${FONT_MONO}`;
    c.textAlign = align;
    c.fillStyle = color;
    c.fillText(s, x, y);
  }

  private button(c: CanvasRenderingContext2D, id: string, label: string, x: number, y: number, w: number, h: number, primary = false): void {
    this.buttons.push({ id, x, y, w, h });
    c.fillStyle = primary ? PAL.gold : 'transparent';
    if (primary) c.fillRect(x, y, w, h);
    c.strokeStyle = primary ? PAL.gold : PAL.ink;
    c.lineWidth = 2;
    c.strokeRect(x + 0.5, y + 0.5, w, h);
    this.text(c, label, x + w / 2, y + h / 2 + 6, 16, primary ? PAL.paperDeep : PAL.ink, 'center');
  }

  private panel(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    c.fillStyle = 'rgba(10,31,56,0.93)';
    c.fillRect(x, y, w, h);
    c.strokeStyle = PAL.ink;
    c.lineWidth = 2;
    c.strokeRect(x + 0.5, y + 0.5, w, h);
    c.lineWidth = 1;
    c.strokeStyle = PAL.dim;
    c.strokeRect(x + 6.5, y + 6.5, w - 12, h - 12);
  }

  private bar(c: CanvasRenderingContext2D, x: number, y: number, frac: number, color: string, segs = 20, w = 200): void {
    const sw = w / segs;
    const filled = Math.ceil(Math.max(0, Math.min(1, frac)) * segs - 1e-6);
    for (let i = 0; i < segs; i++) {
      c.fillStyle = i < filled ? color : 'rgba(141,179,216,0.22)';
      c.fillRect(x + i * sw, y, sw - 2, 10);
    }
  }

  // ---- HUD --------------------------------------------------------------------------------------

  drawHud(c: CanvasRenderingContext2D, sim: Sim, time: number, muted: boolean): void {
    this.buttons = [];
    const s = sim.shipC;
    const b = sim.body.get(sim.ship)!;
    const speed = Math.hypot(b.vx, b.vy);

    this.text(c, 'HULL', 24, 30, 12, PAL.dim);
    this.bar(c, 70, 21, s.hull / SHIP.hull, s.hull < 30 ? PAL.warn : PAL.ink);
    this.text(c, String(Math.ceil(s.hull)).padStart(3, '0'), 280, 30, 12, PAL.ink);
    this.text(c, 'FUEL', 24, 52, 12, PAL.dim);
    this.bar(c, 70, 43, s.fuel / SHIP.fuel, s.fuel < 20 ? PAL.warn : PAL.gold);
    this.text(c, String(Math.ceil(s.fuel)).padStart(3, '0'), 280, 52, 12, PAL.ink);
    this.text(c, 'BURN', 24, 74, 12, PAL.dim);
    this.bar(c, 70, 65, 1 - Math.max(0, s.burnCd) / SHIP.burnCooldown, PAL.dim, 10, 100);
    this.text(c, 'TOW', 190, 74, 12, PAL.dim);
    for (let i = 0; i < SHIP.maxTow; i++) {
      c.strokeStyle = PAL.gold;
      c.fillStyle = i < s.towCount ? PAL.gold : 'transparent';
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(236 + i * 20, 70, 6, 0, TAU);
      if (i < s.towCount) c.fill();
      c.stroke();
    }

    this.text(c, `SECTOR ${sim.sector}/${MAX_SECTOR} · ${sim.plan.name}`, VIEW_W - 24, 30, 14, PAL.ink, 'right');
    this.text(c, `CARGO ${sim.podsDelivered}/${sim.quota} REQUIRED · ${sim.podsRemaining} DRIFTING · ${sim.podsLost} LOST`, VIEW_W - 24, 50, 12, PAL.gold, 'right');
    this.text(c, `SCORE ${String(sim.stats.score).padStart(5, '0')}`, VIEW_W - 24, 70, 12, PAL.dim, 'right');

    this.text(c, `VEL ${String(Math.round(speed)).padStart(3, '0')}`, 24, VIEW_H - 24, 13, PAL.dim);
    const st = s.fsm.state;
    this.text(c, st.toUpperCase(), 24, VIEW_H - 44, 12, st === 'Stunned' ? PAL.warn : PAL.dim);

    const msg: string[] = [];
    if (st === 'Docked') msg.push('DOCKED · REFUELING AND REPAIRING');
    if (s.fuel <= 0 && st !== 'Docked') msg.push(`OUT OF FUEL · STRANDED IN ${Math.max(0, 10 - s.strand).toFixed(1)}`);
    else if (s.fuel < 20 && Math.floor(time * 3) % 2 === 0) msg.push('LOW FUEL');
    msg.forEach((m, i) => this.text(c, m, VIEW_W / 2, VIEW_H - 34 - i * 20, 14, m.startsWith('DOCKED') ? PAL.gold : PAL.warn, 'center'));

    this.minimap(c, sim);
    this.text(c, muted ? 'M: UNMUTE' : 'M: MUTE', VIEW_W - 24, 92, 11, PAL.dim, 'right');
  }

  private minimap(c: CanvasRenderingContext2D, sim: Sim): void {
    const w = 210;
    const h = (w * WORLD_H) / WORLD_W;
    const x = VIEW_W - w - 20;
    const y = VIEW_H - h - 20;
    const kx = w / WORLD_W;
    const ky = h / WORLD_H;
    c.fillStyle = 'rgba(10,31,56,0.85)';
    c.fillRect(x, y, w, h);
    c.strokeStyle = PAL.ink;
    c.lineWidth = 1.5;
    c.strokeRect(x + 0.5, y + 0.5, w, h);
    c.strokeStyle = PAL.dim;
    c.lineWidth = 1;
    for (const p of sim.planets) {
      c.beginPath();
      c.arc(x + p.x * kx, y + p.y * ky, Math.max(3, p.r * kx), 0, TAU);
      c.stroke();
    }
    c.strokeStyle = PAL.gold;
    c.beginPath();
    c.arc(x + sim.beacon.x * kx, y + sim.beacon.y * ky, 5, 0, TAU);
    c.stroke();
    for (const [e, pc] of sim.pod) {
      const t = sim.tf.get(e)!;
      c.fillStyle = pc.mode === 'carried' ? PAL.warn : PAL.gold;
      c.fillRect(x + t.x * kx - 1.5, y + t.y * ky - 1.5, 3, 3);
    }
    c.fillStyle = PAL.warn;
    for (const [e, k] of sim.kind) {
      if (k !== 'mine' && k !== 'interceptor' && k !== 'leech') continue;
      const t = sim.tf.get(e)!;
      c.fillRect(x + t.x * kx - 1.5, y + t.y * ky - 1.5, 3, 3);
    }
    const st = sim.tf.get(sim.ship)!;
    c.fillStyle = PAL.ink;
    c.beginPath();
    c.arc(x + st.x * kx, y + st.y * ky, 3, 0, TAU);
    c.fill();
  }

  // ---- screens ----------------------------------------------------------------------------------

  drawTitle(c: CanvasRenderingContext2D, time: number): void {
    this.buttons = [];
    c.fillStyle = PAL.paper;
    c.fillRect(0, 0, VIEW_W, VIEW_H);
    c.strokeStyle = PAL.gridMinor;
    c.lineWidth = 1;
    c.beginPath();
    for (let x = 0; x <= VIEW_W; x += 40) {
      c.moveTo(x, 0);
      c.lineTo(x, VIEW_H);
    }
    for (let y = 0; y <= VIEW_H; y += 40) {
      c.moveTo(0, y);
      c.lineTo(VIEW_W, y);
    }
    c.stroke();

    // Orbit study on the right.
    const cx = 930;
    const cy = 330;
    c.strokeStyle = PAL.dim;
    c.setLineDash([6, 8]);
    for (const r of [150, 230]) {
      c.beginPath();
      c.arc(cx, cy, r, 0, TAU);
      c.stroke();
    }
    c.setLineDash([]);
    c.fillStyle = PAL.paperDeep;
    c.strokeStyle = PAL.ink;
    c.lineWidth = 2.5;
    c.beginPath();
    c.arc(cx, cy, 78, 0, TAU);
    c.fill();
    c.stroke();
    c.save();
    c.beginPath();
    c.arc(cx, cy, 78, 0, TAU);
    c.clip();
    c.strokeStyle = PAL.dim;
    c.globalAlpha = 0.4;
    c.lineWidth = 1;
    c.beginPath();
    for (let o = -160; o < 160; o += 9) {
      c.moveTo(cx + o - 80, cy + 80);
      c.lineTo(cx + o + 80, cy - 80);
    }
    c.stroke();
    c.restore();
    const a = time * 0.5;
    c.strokeStyle = PAL.gold;
    c.fillStyle = PAL.paper;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(cx + Math.cos(a) * 150, cy + Math.sin(a) * 150, 11, 0, TAU);
    c.fill();
    c.stroke();
    const b = -time * 0.3 + 1;
    c.save();
    c.translate(cx + Math.cos(b) * 230, cy + Math.sin(b) * 230);
    c.rotate(b - Math.PI / 2);
    c.strokeStyle = PAL.ink;
    c.fillStyle = PAL.paper;
    c.beginPath();
    c.moveTo(18, 0);
    c.lineTo(-12, -11);
    c.lineTo(-7, 0);
    c.lineTo(-12, 11);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
    this.text(c, 'P-01', cx, cy + 4, 14, PAL.ink, 'center');

    this.text(c, 'SHEET 01 · ORBITAL RECOVERY CONTRACT', 70, 120, 13, PAL.dim);
    this.text(c, 'SLINGSHOT', 66, 205, 92, PAL.ink, 'left', true);
    this.text(c, 'SALVAGE', 66, 290, 92, PAL.gold, 'left', true);
    this.text(c, 'Recover drifting cargo from planetary orbits and deliver it to the drop zone.', 70, 332, 15, PAL.ink);
    this.text(c, 'Fuel is limited. Gravity is free. Plan your trajectory.', 70, 354, 15, PAL.dim);

    const rows: [string, string][] = [
      ['A / D · ← / →', 'rotate'],
      ['W · ↑', 'thrust'],
      ['SPACE · J', 'fire pulse'],
      ['SHIFT · K', 'burn (dash)'],
      ['X', 'cut tether'],
      ['P · ESC', 'pause'],
      ['R', 'restart'],
      ['F1 · `', 'debug overlay'],
    ];
    rows.forEach(([k, v], i) => {
      const y = 405 + i * 22;
      this.text(c, k, 70, y, 13, PAL.gold);
      this.text(c, v, 250, y, 13, PAL.ink);
    });
    c.strokeStyle = PAL.dim;
    c.lineWidth = 1;
    c.strokeRect(60.5, 386.5, 330, 190);

    this.button(c, 'start', 'BEGIN CONTRACT  [ENTER]', 70, 610, 280, 46, true);
    this.text(c, 'DASHED RINGS = EQUAL GRAVITY PULL · DOTTED LINE = YOUR DRIFT PATH', 70, 690, 11, PAL.dim);
  }

  drawPause(c: CanvasRenderingContext2D): void {
    this.buttons = [];
    c.fillStyle = 'rgba(10,31,56,0.6)';
    c.fillRect(0, 0, VIEW_W, VIEW_H);
    this.panel(c, VIEW_W / 2 - 220, 220, 440, 250);
    this.text(c, 'PAUSED', VIEW_W / 2, 290, 44, PAL.ink, 'center', true);
    this.button(c, 'resume', 'RESUME  [P]', VIEW_W / 2 - 120, 330, 240, 42, true);
    this.button(c, 'restart', 'RESTART  [R]', VIEW_W / 2 - 120, 386, 240, 42);
  }

  drawEnd(c: CanvasRenderingContext2D, sim: Sim, kind: 'clear' | 'won' | 'lost'): void {
    this.buttons = [];
    c.fillStyle = 'rgba(10,31,56,0.55)';
    c.fillRect(0, 0, VIEW_W, VIEW_H);
    const w = 560;
    const h = 430;
    const x = VIEW_W / 2 - w / 2;
    const y = 140;
    this.panel(c, x, y, w, h);
    const st = sim.stats;
    const title = kind === 'clear' ? `SECTOR ${sim.sector} CLEARED` : kind === 'won' ? 'CONTRACT COMPLETE' : REASONS[sim.failReason] ?? 'MISSION FAILED';
    const color = kind === 'lost' ? PAL.warn : PAL.gold;
    this.text(c, kind === 'lost' ? 'MISSION FAILED' : kind === 'won' ? 'ALL SECTORS RECOVERED' : sim.plan.name, VIEW_W / 2, y + 44, 13, PAL.dim, 'center');
    this.text(c, title, VIEW_W / 2, y + 92, kind === 'lost' && title.length > 20 ? 26 : 44, color, 'center', true);
    const acc = st.shotsFired > 0 ? Math.round((st.shotsHit / st.shotsFired) * 100) : 0;
    const rows: [string, string][] = [
      ['SECTORS', `${st.sectors}/${MAX_SECTOR}`],
      ['CARGO DELIVERED', String(st.podsDelivered)],
      ['CARGO LOST', String(st.podsLost)],
      ['HOSTILES DOWN', String(st.kills)],
      ['PULSE ACCURACY', `${acc}%`],
      ['CRASHES', String(st.crashes)],
      ['HULL DAMAGE TAKEN', String(Math.round(st.damageTaken))],
      ['FUEL BURNED', String(Math.round(st.fuelBurned))],
      ['FLIGHT TIME', `${Math.floor(st.time / 60)}:${String(Math.floor(st.time % 60)).padStart(2, '0')}`],
    ];
    rows.forEach(([k, v], i) => {
      const ry = y + 140 + i * 24;
      this.text(c, k, x + 60, ry, 13, PAL.dim);
      this.text(c, v, x + w - 60, ry, 13, PAL.ink, 'right');
    });
    this.text(c, `SCORE ${String(st.score).padStart(5, '0')}`, VIEW_W / 2, y + 380, 20, PAL.gold, 'center');
    if (kind === 'clear') {
      this.button(c, 'next', 'NEXT SECTOR  [ENTER]', VIEW_W / 2 - 130, y + h + 16, 260, 42, true);
    } else {
      this.button(c, 'restart', 'NEW CONTRACT  [R]', VIEW_W / 2 - 130, y + h + 16, 260, 42, true);
    }
  }
}
