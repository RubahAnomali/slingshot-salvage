import type { Entity } from '../core/Ecs';
import { interceptTime } from '../core/math';
import { INTERCEPTOR, LEECH, MINE, POD, SHIP, WORLD_H, WORLD_W } from './config';
import type { Sim } from './World';
import type { Brain } from './types';

/** Move velocity toward `dvx,dvy` by at most `accel*dt` (a thruster-limited steering primitive). */
function steer(sim: Sim, e: Entity, dvx: number, dvy: number, accel: number, dt: number, maxSpeed: number): void {
  const b = sim.body.get(e)!;
  let tx = dvx;
  let ty = dvy;
  const m = Math.hypot(tx, ty);
  if (m > maxSpeed) {
    tx = (tx / m) * maxSpeed;
    ty = (ty / m) * maxSpeed;
  }
  let ax = tx - b.vx;
  let ay = ty - b.vy;
  const am = Math.hypot(ax, ay);
  const lim = accel * dt;
  if (am > lim) {
    ax = (ax / am) * lim;
    ay = (ay / am) * lim;
  }
  b.vx += ax;
  b.vy += ay;
}

/** Outward push from any planet whose danger margin we are inside. Returns an acceleration to add. */
function planetAvoid(sim: Sim, x: number, y: number, out: { x: number; y: number }): boolean {
  out.x = 0;
  out.y = 0;
  let any = false;
  for (const p of sim.planets) {
    const dx = x - p.x;
    const dy = y - p.y;
    const d = Math.hypot(dx, dy) || 1;
    const margin = p.r * 2.4 + 40;
    if (d < margin) {
      const k = ((margin - d) / margin) ** 1.2 * 900;
      out.x += (dx / d) * k;
      out.y += (dy / d) * k;
      any = true;
    }
  }
  return any;
}

const tmp = { x: 0, y: 0 };

function newWaypoint(sim: Sim, br: Brain): void {
  br.waypointX = sim.rng.range(200, WORLD_W - 200);
  br.waypointY = sim.rng.range(200, WORLD_H - 200);
  br.t1 = sim.rng.range(4, 7);
}

// ---- Interceptor ------------------------------------------------------------------------------------
// Brain fields: t1 = patrol retarget timer / fire-burst gap, t2 = attack cooldown.
// Hunt keeps a standoff ring around the *predicted* ship position, so it can't be shaken by simply
// reversing; Charge telegraphs, tracks the lead point, then locks the angle for the last `lockTime`.

export function updateInterceptor(sim: Sim, e: Entity, dt: number): void {
  const br = sim.brain.get(e)!;
  const t = sim.tf.get(e)!;
  const b = sim.body.get(e)!;
  const fsm = br.fsm;
  fsm.update(dt);
  br.t2 -= dt;
  const alive = sim.shipAlive();
  const st = sim.tf.get(sim.ship)!;
  const sb = sim.body.get(sim.ship)!;
  const dx = st.x - t.x;
  const dy = st.y - t.y;
  const d = Math.hypot(dx, dy) || 1;
  const C = INTERCEPTOR;

  // Facing follows velocity unless aiming.
  const aimed = fsm.state === 'Charge' || fsm.state === 'Fire';
  if (!aimed && Math.hypot(b.vx, b.vy) > 20) t.a = Math.atan2(b.vy, b.vx);

  const avoid = planetAvoid(sim, t.x, t.y, tmp);
  if (avoid) {
    b.vx += tmp.x * dt;
    b.vy += tmp.y * dt;
  }

  switch (fsm.state) {
    case 'Patrol': {
      br.note = 'patrol';
      br.t1 -= dt;
      if (br.t1 <= 0 || Math.hypot(br.waypointX - t.x, br.waypointY - t.y) < 70) newWaypoint(sim, br);
      const wx = br.waypointX - t.x;
      const wy = br.waypointY - t.y;
      const wd = Math.hypot(wx, wy) || 1;
      steer(sim, e, (wx / wd) * 120, (wy / wd) * 120, C.accel, dt, 120);
      if (alive && d < C.huntRange) fsm.request('Hunt');
      break;
    }
    case 'Hunt': {
      br.note = `standoff ${C.standoff}`;
      // Point on a ring around the predicted ship position, biased toward where we already are.
      const px = st.x + sb.vx * 0.6;
      const py = st.y + sb.vy * 0.6;
      let ux = t.x - px;
      let uy = t.y - py;
      const um = Math.hypot(ux, uy) || 1;
      ux /= um;
      uy /= um;
      const sway = Math.sin(fsm.time * 1.3 + e) * 0.55;
      const c = Math.cos(sway);
      const s = Math.sin(sway);
      const rx = ux * c - uy * s;
      const ry = ux * s + uy * c;
      const gx = px + rx * C.standoff;
      const gy = py + ry * C.standoff;
      steer(sim, e, (gx - t.x) * 1.4, (gy - t.y) * 1.4, C.accel, dt, C.maxSpeed);
      t.a = Math.atan2(dy, dx);
      if (!alive || d > C.loseRange) fsm.request('Patrol');
      else if (d < C.fireRange && br.t2 <= 0 && sim.losClear(t.x, t.y, st.x, st.y)) fsm.request('Charge');
      break;
    }
    case 'Charge': {
      br.note = 'charging';
      const k = Math.exp(-2.6 * dt);
      b.vx *= k;
      b.vy *= k;
      if (!alive) {
        fsm.request('Hunt');
        break;
      }
      if (fsm.time < C.charge - C.lockTime) {
        const tt = interceptTime(t.x, t.y, st.x, st.y, sb.vx, sb.vy, C.boltSpeed);
        const lead = tt > 0 ? Math.min(tt, 1.6) : 0;
        br.aimX = st.x + sb.vx * lead;
        br.aimY = st.y + sb.vy * lead;
        br.lockedA = Math.atan2(br.aimY - t.y, br.aimX - t.x);
      }
      t.a = br.lockedA;
      if (fsm.time >= C.charge) {
        br.burstLeft = C.burst;
        br.t1 = 0;
        fsm.request('Fire');
      }
      break;
    }
    case 'Fire': {
      br.note = `burst ${br.burstLeft}`;
      const k = Math.exp(-3 * dt);
      b.vx *= k;
      b.vy *= k;
      t.a = br.lockedA;
      br.t1 -= dt;
      if (br.burstLeft > 0 && br.t1 <= 0) {
        const nx = Math.cos(br.lockedA);
        const ny = Math.sin(br.lockedA);
        sim.spawnBolt(t.x + nx * 18, t.y + ny * 18, br.lockedA, C.boltSpeed, true, C.boltDamage, C.boltLife, 0, 0);
        br.burstLeft--;
        br.t1 = C.burstGap;
      }
      if (br.burstLeft === 0 && br.t1 <= 0) fsm.request('Recover');
      break;
    }
    case 'Recover': {
      br.note = 'repositioning';
      const away = Math.atan2(-dy, -dx) + (e % 2 === 0 ? 0.9 : -0.9);
      steer(sim, e, Math.cos(away) * C.maxSpeed, Math.sin(away) * C.maxSpeed, C.accel, dt, C.maxSpeed);
      if (fsm.time > C.recover) {
        br.t2 = C.cooldown;
        fsm.request('Hunt');
      }
      break;
    }
  }
}

// ---- Mine -------------------------------------------------------------------------------------------

export function updateMine(sim: Sim, e: Entity, dt: number): void {
  const br = sim.brain.get(e)!;
  const m = sim.mine.get(e)!;
  const t = sim.tf.get(e)!;
  const b = sim.body.get(e)!;
  br.fsm.update(dt);
  const alive = sim.shipAlive();
  const st = sim.tf.get(sim.ship)!;
  const d = Math.hypot(st.x - t.x, st.y - t.y);
  t.a += dt * 0.8;
  if (br.fsm.state === 'Idle') {
    br.note = 'drifting';
    if (alive && d < MINE.trigger) {
      br.fsm.request('Armed');
      m.fuse = MINE.fuse;
      if (!m.warned) {
        m.warned = true;
        sim.bus.emit('WARN', { kind: 'mine', x: t.x, y: t.y });
      }
    }
  } else {
    br.note = `fuse ${m.fuse.toFixed(2)}`;
    m.fuse -= dt;
    if (alive) {
      const ux = (st.x - t.x) / (d || 1);
      const uy = (st.y - t.y) / (d || 1);
      b.vx += ux * MINE.homing * dt;
      b.vy += uy * MINE.homing * dt;
    }
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > MINE.maxSpeed) {
      b.vx *= MINE.maxSpeed / sp;
      b.vy *= MINE.maxSpeed / sp;
    }
    if (m.fuse <= 0) sim.detonate(e);
  }
}

// ---- Leech ------------------------------------------------------------------------------------------
// Brain fields: target = pod being hunted/carried, t1 = evade timer.
// Utility-style target pick: nearest stealable pod, with towed pods discounted (harder to reach) and
// the ship as the fallback so a leech is never idle.

export function updateLeech(sim: Sim, e: Entity, dt: number): void {
  const br = sim.brain.get(e)!;
  const t = sim.tf.get(e)!;
  const b = sim.body.get(e)!;
  const fsm = br.fsm;
  fsm.update(dt);
  const alive = sim.shipAlive();
  const st = sim.tf.get(sim.ship)!;
  const C = LEECH;
  if (Math.hypot(b.vx, b.vy) > 20) t.a = Math.atan2(b.vy, b.vx);

  const avoid = planetAvoid(sim, t.x, t.y, tmp);
  if (avoid) {
    b.vx += tmp.x * dt;
    b.vy += tmp.y * dt;
  }

  if (fsm.state === 'Seek') {
    // Choose a target.
    let best: Entity = 0;
    let bestScore = Infinity;
    for (const [pe, pc] of sim.pod) {
      if (pc.mode === 'carried' || !sim.ecs.isLive(pe)) continue;
      const pt = sim.tf.get(pe)!;
      const dd = Math.hypot(pt.x - t.x, pt.y - t.y);
      const score = dd * (pc.mode === 'towed' ? 1.4 : 1);
      if (score < bestScore) {
        bestScore = score;
        best = pe;
      }
    }
    br.target = best;
    let gx = st.x;
    let gy = st.y;
    if (best) {
      const pt = sim.tf.get(best)!;
      const pb = sim.body.get(best)!;
      gx = pt.x + pb.vx * 0.35;
      gy = pt.y + pb.vy * 0.35;
      br.note = `stalking pod #${best}`;
    } else {
      br.note = alive ? 'ramming ship' : 'idle';
    }
    const dx = gx - t.x;
    const dy = gy - t.y;
    const d = Math.hypot(dx, dy) || 1;
    steer(sim, e, (dx / d) * C.maxSpeed, (dy / d) * C.maxSpeed, C.accel, dt, C.maxSpeed);

    if (best) {
      const pt = sim.tf.get(best)!;
      const pc = sim.pod.get(best)!;
      if (pc.grabCd <= 0 && Math.hypot(pt.x - t.x, pt.y - t.y) < C.radius + POD.radius + 4) {
        if (pc.mode === 'towed') sim.removeFromChain(best);
        pc.mode = 'carried';
        pc.link = e;
        br.target = best;
        sim.bus.emit('POD_RELEASE', { x: pt.x, y: pt.y });
        fsm.request('Carry');
      }
    } else if (alive && d < C.radius + SHIP.radius + 4) {
      sim.damageShip(C.ramDamage, t.x, t.y, false);
      br.t1 = C.evade;
      fsm.request('Evade');
    }
  } else if (fsm.state === 'Carry') {
    const pc = sim.pod.get(br.target);
    if (!pc || !sim.ecs.isLive(br.target) || pc.mode !== 'carried' || pc.link !== e) {
      fsm.request('Seek');
      return;
    }
    // Run for the nearest world edge.
    const dl = t.x;
    const dr = WORLD_W - t.x;
    const dtp = t.y;
    const db = WORLD_H - t.y;
    const m = Math.min(dl, dr, dtp, db);
    let ex = t.x;
    let ey = t.y;
    if (m === dl) ex = -200;
    else if (m === dr) ex = WORLD_W + 200;
    else if (m === dtp) ey = -200;
    else ey = WORLD_H + 200;
    const vx = ex - t.x;
    const vy = ey - t.y;
    const vm = Math.hypot(vx, vy) || 1;
    steer(sim, e, (vx / vm) * C.fleeSpeed, (vy / vm) * C.fleeSpeed, C.accel, dt, C.fleeSpeed);
    br.note = `fleeing with pod #${br.target}`;
    const pt = sim.tf.get(br.target)!;
    const pb = sim.body.get(br.target)!;
    pt.x = t.x - Math.cos(t.a) * 20;
    pt.y = t.y - Math.sin(t.a) * 20;
    pb.vx = b.vx;
    pb.vy = b.vy;
    if (t.x < 24 || t.x > WORLD_W - 24 || t.y < 24 || t.y > WORLD_H - 24) {
      sim.losePod(br.target, 'stolen');
      sim.ecs.kill(e);
    }
  } else {
    // Evade
    br.note = 'evading';
    br.t1 -= dt;
    const dx = t.x - st.x;
    const dy = t.y - st.y;
    const d = Math.hypot(dx, dy) || 1;
    steer(sim, e, (dx / d) * C.maxSpeed, (dy / d) * C.maxSpeed, C.accel, dt, C.maxSpeed);
    if (br.t1 <= 0) fsm.request('Seek');
  }
}
