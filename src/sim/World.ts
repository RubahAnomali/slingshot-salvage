import { Ecs, type Entity } from '../core/Ecs';
import type { EventBus } from '../core/EventBus';
import { Rng, segmentHitsCircle } from '../core/math';
import { ObjectPool } from '../core/ObjectPool';
import { SpatialHash } from '../core/SpatialHash';
import { StateMachine } from '../core/StateMachine';
import { updateInterceptor, updateLeech, updateMine } from './ai';
import {
  GRAVITY_ON_BOLT,
  INTERCEPTOR,
  LEECH,
  MAX_SECTOR,
  MINE,
  POD,
  SHIP,
  Tuning,
  WORLD_H,
  WORLD_W,
} from './config';
import { accelAt } from './gravity';
import { generateSector, type SectorPlan } from './Sector';
import type {
  Beacon,
  BoltC,
  Body,
  Brain,
  GameOverReason,
  Health,
  InputState,
  InterceptorState,
  Kind,
  LeechState,
  Life,
  MineC,
  MineState,
  Planet,
  PodC,
  ShipC,
  ShipState,
  SimEvents,
  Stats,
  Transform,
} from './types';

export type Phase = 'play' | 'clear' | 'won' | 'lost';

const SHIP_ALLOWED: Record<ShipState, readonly ShipState[]> = {
  Drift: ['Thrust', 'Burn', 'Stunned', 'Docked', 'Dead'],
  Thrust: ['Drift', 'Burn', 'Stunned', 'Dead'],
  Burn: ['Drift', 'Stunned', 'Dead'],
  Stunned: ['Drift', 'Dead'],
  Docked: ['Drift', 'Burn', 'Stunned', 'Dead'],
  Dead: [],
};

const INTERCEPTOR_ALLOWED: Record<InterceptorState, readonly InterceptorState[]> = {
  Patrol: ['Hunt'],
  Hunt: ['Patrol', 'Charge'],
  Charge: ['Fire', 'Hunt'],
  Fire: ['Recover'],
  Recover: ['Hunt', 'Patrol'],
};

const LEECH_ALLOWED: Record<LeechState, readonly LeechState[]> = {
  Seek: ['Carry', 'Evade'],
  Carry: ['Seek'],
  Evade: ['Seek'],
};

const MINE_ALLOWED: Record<MineState, readonly MineState[]> = {
  Idle: ['Armed'],
  Armed: [],
};

interface BoltBundle {
  tf: Transform;
  body: Body;
  life: Life;
  bolt: BoltC;
}

const newStats = (): Stats => ({
  sectors: 0,
  podsDelivered: 0,
  podsLost: 0,
  kills: 0,
  shotsFired: 0,
  shotsHit: 0,
  crashes: 0,
  damageTaken: 0,
  fuelBurned: 0,
  time: 0,
  score: 0,
});

/**
 * The whole simulation. No DOM, canvas or audio in here: it advances by fixed ticks and reports what
 * happened through the typed event bus.
 */
export class Sim {
  readonly ecs = new Ecs();
  readonly tf = this.ecs.store<Transform>();
  readonly body = this.ecs.store<Body>();
  readonly kind = this.ecs.store<Kind>();
  readonly health = this.ecs.store<Health>();
  readonly pod = this.ecs.store<PodC>();
  readonly bolt = this.ecs.store<BoltC>();
  readonly life = this.ecs.store<Life>();
  readonly brain = this.ecs.store<Brain>();
  readonly mine = this.ecs.store<MineC>();

  readonly hash = new SpatialHash(96);
  readonly boltPool = new ObjectPool<BoltBundle>(
    () => ({
      tf: { x: 0, y: 0, px: 0, py: 0, a: 0, pa: 0 },
      body: { vx: 0, vy: 0, mass: 0.1, radius: 4, drag: 0, gravity: GRAVITY_ON_BOLT },
      life: { t: 0 },
      bolt: { damage: 1, hostile: false },
    }),
    () => undefined,
    64,
  );
  private readonly bundles = new Map<Entity, BoltBundle>();

  planets: Planet[] = [];
  beacon: Beacon = { x: WORLD_W / 2, y: WORLD_H / 2, r: 90 };
  plan!: SectorPlan;

  ship: Entity = 0;
  shipC!: ShipC;
  /** Pods currently on the ship's tether, nearest to the ship first. */
  chain: Entity[] = [];

  phase: Phase = 'play';
  sector = 0;
  tick = 0;
  sectorTime = 0;
  stats: Stats = newStats();
  podsTotal = 0;
  podsDelivered = 0;
  podsLost = 0;
  quota = 0;
  reinforce = 30;
  seed = 1;
  rng = new Rng(1);
  readonly input: InputState = { left: false, right: false, thrust: false, fire: false, burnPressed: false, releasePressed: false };
  failReason: GameOverReason = 'hull';

  private readonly buf: number[] = [];
  private readonly acc = { x: 0, y: 0 };
  private lowFuelWarned = false;

  constructor(readonly bus: EventBus<SimEvents>) {}

  // ---- run / sector lifecycle ------------------------------------------------------------------

  newRun(seed: number): void {
    this.seed = seed;
    this.stats = newStats();
    this.sector = 0;
    this.startSector(1, true);
  }

  nextSector(): void {
    if (this.phase !== 'clear') return;
    this.startSector(this.sector + 1, false);
  }

  private startSector(n: number, fresh: boolean): void {
    const carriedHull = fresh ? SHIP.hull : Math.min(SHIP.hull, (this.shipC?.hull ?? SHIP.hull) + 30);
    this.ecs.clear();
    this.hash.clear();
    this.bundles.clear();
    this.chain.length = 0;
    this.sector = n;
    this.phase = 'play';
    this.tick = 0;
    this.sectorTime = 0;
    this.podsDelivered = 0;
    this.podsLost = 0;
    this.lowFuelWarned = false;
    this.rng = new Rng(this.seed * 31 + n * 101);
    this.plan = generateSector(n, this.seed);
    this.planets = this.plan.planets;
    this.beacon = this.plan.beacon;
    this.podsTotal = this.plan.pods.length;
    this.quota = this.plan.quota;
    this.reinforce = Math.max(12, 32 - n * 3);
    this.stats.sectors = n;

    this.spawnShip(carriedHull);
    for (const p of this.plan.pods) this.spawnPod(p.x, p.y, p.vx, p.vy);
    for (let i = 0; i < this.plan.mines; i++) this.spawnAtFarPoint('mine');
    for (let i = 0; i < this.plan.interceptors; i++) this.spawnAtFarPoint('interceptor');
    for (let i = 0; i < this.plan.leeches; i++) this.spawnAtFarPoint('leech');
    this.bus.emit('SECTOR_START', { sector: n });
  }

  // ---- spawning ---------------------------------------------------------------------------------

  private makeTf(x: number, y: number, a = 0): Transform {
    return { x, y, px: x, py: y, a, pa: a };
  }

  private spawnShip(hull: number): void {
    const e = this.ecs.create();
    this.ship = e;
    this.tf.set(e, this.makeTf(this.beacon.x, this.beacon.y, -Math.PI / 2));
    this.body.set(e, { vx: 0, vy: 0, mass: 1, radius: SHIP.radius, drag: Tuning.drag, gravity: 1 });
    this.kind.set(e, 'ship');
    this.health.set(e, { hp: hull, max: SHIP.hull, flash: 0 });
    const fsm = new StateMachine<ShipState>('Drift', SHIP_ALLOWED, {
      Thrust: {
        enter: () => this.bus.emit('THRUST', { on: true }),
        exit: () => this.bus.emit('THRUST', { on: false }),
      },
      Docked: {
        enter: () => this.bus.emit('DOCK', { on: true }),
        exit: () => this.bus.emit('DOCK', { on: false }),
      },
      Burn: { enter: () => this.applyBurn() },
    });
    this.shipC = {
      fsm,
      hull,
      fuel: SHIP.fuel,
      av: 0,
      fireCd: 0,
      burnCd: 0,
      burnLeft: 0,
      burnBuf: 0,
      fireBuf: 0,
      stun: 0,
      invuln: 1,
      strand: 0,
      towCount: 0,
      thrusting: false,
    };
  }

  private spawnPod(x: number, y: number, vx: number, vy: number): Entity {
    const e = this.ecs.create();
    this.tf.set(e, this.makeTf(x, y));
    this.body.set(e, { vx, vy, mass: POD.mass, radius: POD.radius, drag: 0, gravity: 1 });
    this.kind.set(e, 'pod');
    this.pod.set(e, { mode: 'free', link: 0, grabCd: 0 });
    return e;
  }

  private newBrain(fsm: StateMachine<string>): Brain {
    return {
      fsm,
      t1: 0,
      t2: 0,
      burstLeft: 0,
      aimX: 0,
      aimY: 0,
      lockedA: 0,
      waypointX: 0,
      waypointY: 0,
      target: 0,
      note: '',
    };
  }

  spawnEnemy(kind: 'mine' | 'interceptor' | 'leech', x: number, y: number): Entity {
    const e = this.ecs.create();
    const ang = this.rng.range(0, Math.PI * 2);
    this.kind.set(e, kind);
    this.tf.set(e, this.makeTf(x, y, ang));
    if (kind === 'mine') {
      const sp = this.rng.range(10, 40);
      this.body.set(e, { vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, mass: 2, radius: MINE.radius, drag: 0.05, gravity: 1 });
      this.health.set(e, { hp: 1, max: 1, flash: 0 });
      this.mine.set(e, { fuse: 0, warned: false });
      const fsm = new StateMachine<MineState>('Idle', MINE_ALLOWED);
      this.brain.set(e, this.newBrain(fsm as StateMachine<string>));
    } else if (kind === 'interceptor') {
      this.body.set(e, { vx: 0, vy: 0, mass: 3, radius: INTERCEPTOR.radius, drag: 0.1, gravity: 1 });
      this.health.set(e, { hp: INTERCEPTOR.hp, max: INTERCEPTOR.hp, flash: 0 });
      const fsm = new StateMachine<InterceptorState>('Patrol', INTERCEPTOR_ALLOWED, {
        Charge: { enter: () => this.bus.emit('WARN', { kind: 'interceptor', x: this.tf.get(e)?.x ?? 0, y: this.tf.get(e)?.y ?? 0 }) },
      });
      const br = this.newBrain(fsm as StateMachine<string>);
      br.waypointX = this.rng.range(200, WORLD_W - 200);
      br.waypointY = this.rng.range(200, WORLD_H - 200);
      br.t1 = this.rng.range(2, 5);
      br.t2 = this.rng.range(0.5, 2);
      this.brain.set(e, br);
    } else {
      this.body.set(e, { vx: 0, vy: 0, mass: 2, radius: LEECH.radius, drag: 0.1, gravity: 1 });
      this.health.set(e, { hp: LEECH.hp, max: LEECH.hp, flash: 0 });
      const fsm = new StateMachine<LeechState>('Seek', LEECH_ALLOWED);
      this.brain.set(e, this.newBrain(fsm as StateMachine<string>));
    }
    return e;
  }

  private spawnAtFarPoint(kind: 'mine' | 'interceptor' | 'leech'): void {
    const st = this.tf.get(this.ship)!;
    for (let i = 0; i < 60; i++) {
      const x = this.rng.range(120, WORLD_W - 120);
      const y = this.rng.range(120, WORLD_H - 120);
      if (Math.hypot(x - st.x, y - st.y) < 800) continue;
      if (this.planets.some((p) => Math.hypot(p.x - x, p.y - y) < p.r * 2.6 + 40)) continue;
      this.spawnEnemy(kind, x, y);
      return;
    }
    this.spawnEnemy(kind, 150, 150);
  }

  spawnBolt(x: number, y: number, a: number, speed: number, hostile: boolean, damage: number, life: number, ivx: number, ivy: number): void {
    const e = this.ecs.create();
    const b = this.boltPool.acquire();
    b.tf.x = b.tf.px = x;
    b.tf.y = b.tf.py = y;
    b.tf.a = b.tf.pa = a;
    b.body.vx = Math.cos(a) * speed + ivx;
    b.body.vy = Math.sin(a) * speed + ivy;
    b.life.t = life;
    b.bolt.damage = damage;
    b.bolt.hostile = hostile;
    this.bundles.set(e, b);
    this.tf.set(e, b.tf);
    this.body.set(e, b.body);
    this.life.set(e, b.life);
    this.bolt.set(e, b.bolt);
    this.kind.set(e, hostile ? 'ebolt' : 'pbolt');
    this.bus.emit('SHOT', { x, y, a, hostile });
    if (!hostile) this.stats.shotsFired++;
  }

  // ---- queries ----------------------------------------------------------------------------------

  shipAlive(): boolean {
    return this.shipC.fsm.state !== 'Dead';
  }

  losClear(ax: number, ay: number, bx: number, by: number): boolean {
    for (const p of this.planets) if (segmentHitsCircle(ax, ay, bx, by, p.x, p.y, p.r)) return false;
    return true;
  }

  countKind(k: Kind): number {
    let n = 0;
    for (const [e, kk] of this.kind) if (kk === k && this.ecs.isLive(e)) n++;
    return n;
  }

  get podsRemaining(): number {
    return this.podsTotal - this.podsDelivered - this.podsLost;
  }

  // ---- damage & destruction ---------------------------------------------------------------------

  damageShip(dmg: number, x: number, y: number, stun: boolean): boolean {
    const s = this.shipC;
    if (s.fsm.state === 'Dead' || s.invuln > 0 || this.phase !== 'play') return false;
    s.hull = Math.max(0, s.hull - dmg);
    this.stats.damageTaken += dmg;
    s.invuln = stun ? SHIP.invuln : 0.55;
    this.health.get(this.ship)!.flash = 0.15;
    this.bus.emit('HIT', { x, y, dmg, kind: 'ship' });
    if (s.hull <= 0) {
      s.fsm.request('Dead');
      const st = this.tf.get(this.ship)!;
      this.bus.emit('EXPLOSION', { x: st.x, y: st.y, r: 60 });
      this.finish('lost', 'hull');
    } else if (stun) {
      s.stun = SHIP.stunTime;
      s.fsm.request('Stunned');
    }
    return true;
  }

  damageEnemy(e: Entity, dmg: number): void {
    if (!this.ecs.isLive(e)) return;
    const h = this.health.get(e);
    const k = this.kind.get(e);
    const t = this.tf.get(e);
    if (!h || !k || !t) return;
    h.hp -= dmg;
    h.flash = 0.12;
    this.bus.emit('HIT', { x: t.x, y: t.y, dmg, kind: k });
    if (h.hp <= 0) this.destroyEnemy(e, true);
  }

  destroyEnemy(e: Entity, byPlayer: boolean): void {
    if (!this.ecs.isLive(e)) return;
    const k = this.kind.get(e)!;
    const t = this.tf.get(e)!;
    const b = this.body.get(e)!;
    if (k === 'mine') {
      this.detonate(e);
      if (byPlayer) this.noteKill();
      return;
    }
    if (k === 'leech') {
      const br = this.brain.get(e)!;
      const pc = this.pod.get(br.target);
      if (pc && pc.mode === 'carried' && pc.link === e) {
        pc.mode = 'free';
        pc.link = 0;
        pc.grabCd = 0.8;
        const pb = this.body.get(br.target)!;
        pb.vx = b.vx;
        pb.vy = b.vy;
      }
    }
    this.ecs.kill(e);
    this.bus.emit('ENEMY_DOWN', { kind: k, x: t.x, y: t.y });
    if (byPlayer) this.noteKill();
  }

  private noteKill(): void {
    this.stats.kills++;
    this.stats.score += 25;
  }

  detonate(e: Entity): void {
    if (!this.ecs.isLive(e)) return;
    const t = this.tf.get(e)!;
    this.ecs.kill(e);
    this.bus.emit('EXPLOSION', { x: t.x, y: t.y, r: MINE.blast });
    this.bus.emit('ENEMY_DOWN', { kind: 'mine', x: t.x, y: t.y });
    const R = MINE.blast;
    // Ship
    const st = this.tf.get(this.ship)!;
    const sd = Math.hypot(st.x - t.x, st.y - t.y);
    if (this.shipAlive() && sd < R + SHIP.radius) {
      const f = 1 - (sd / (R + SHIP.radius)) * 0.5;
      this.damageShip(Math.round(MINE.damage * f), st.x, st.y, true);
      const sb = this.body.get(this.ship)!;
      const ux = (st.x - t.x) / (sd || 1);
      const uy = (st.y - t.y) / (sd || 1);
      sb.vx += ux * 320 * f;
      sb.vy += uy * 320 * f;
    }
    // Everything else in range.
    for (const [oe, k] of this.kind) {
      if (oe === e || oe === this.ship || !this.ecs.isLive(oe)) continue;
      const ot = this.tf.get(oe)!;
      const d = Math.hypot(ot.x - t.x, ot.y - t.y);
      if (d > R) continue;
      if (k === 'pod') {
        this.losePod(oe, 'blast');
      } else if (k === 'mine' || k === 'interceptor' || k === 'leech') {
        this.damageEnemy(oe, 2);
      } else {
        const ob = this.body.get(oe);
        if (ob && k === 'pbolt') this.ecs.kill(oe);
      }
    }
  }

  losePod(e: Entity, why: 'crash' | 'stolen' | 'blast'): void {
    if (!this.ecs.isLive(e) || !this.pod.has(e)) return;
    const t = this.tf.get(e)!;
    this.removeFromChain(e);
    this.ecs.kill(e);
    this.podsLost++;
    this.stats.podsLost++;
    this.bus.emit('POD_LOST', { x: t.x, y: t.y, why });
  }

  // ---- tether -------------------------------------------------------------------------------------

  removeFromChain(e: Entity): void {
    const i = this.chain.indexOf(e);
    if (i < 0) return;
    this.chain.splice(i, 1);
    for (let j = i; j < this.chain.length; j++) {
      this.pod.get(this.chain[j]!)!.link = j === 0 ? this.ship : this.chain[j - 1]!;
    }
    this.shipC.towCount = this.chain.length;
  }

  private releaseAll(): void {
    const st = this.tf.get(this.ship)!;
    if (this.chain.length === 0) return;
    for (const pe of this.chain) {
      const pc = this.pod.get(pe)!;
      pc.mode = 'free';
      pc.link = 0;
      pc.grabCd = 1.0;
    }
    this.chain.length = 0;
    this.shipC.towCount = 0;
    this.bus.emit('POD_RELEASE', { x: st.x, y: st.y });
  }

  private towForces(dt: number): void {
    for (let i = 0; i < this.chain.length; i++) {
      const pe = this.chain[i]!;
      const pc = this.pod.get(pe)!;
      if (!this.ecs.isLive(pc.link) && pc.link !== this.ship) continue;
      const a = this.tf.get(pc.link)!;
      const ab = this.body.get(pc.link)!;
      const p = this.tf.get(pe)!;
      const pb = this.body.get(pe)!;
      const dx = a.x - p.x;
      const dy = a.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d <= SHIP.towRest) continue;
      const nx = dx / d;
      const ny = dy / d;
      const stretch = d - SHIP.towRest;
      const rel = (ab.vx - pb.vx) * nx + (ab.vy - pb.vy) * ny;
      const f = Math.max(0, SHIP.towStiffness * stretch + SHIP.towDamping * rel);
      pb.vx += (nx * f * dt) / pb.mass;
      pb.vy += (ny * f * dt) / pb.mass;
      ab.vx -= (nx * f * dt) / ab.mass;
      ab.vy -= (ny * f * dt) / ab.mass;
    }
  }

  // ---- main step ----------------------------------------------------------------------------------

  step(dt: number): void {
    if (this.phase !== 'play') {
      this.input.burnPressed = false;
      this.input.releasePressed = false;
      return;
    }
    this.tick++;
    this.sectorTime += dt;
    this.stats.time += dt;
    for (const [, t] of this.tf) {
      t.px = t.x;
      t.py = t.y;
      t.pa = t.a;
    }

    this.shipSystem(dt);
    for (const [e] of this.brain) {
      if (!this.ecs.isLive(e)) continue;
      const k = this.kind.get(e);
      if (k === 'interceptor') updateInterceptor(this, e, dt);
      else if (k === 'mine') updateMine(this, e, dt);
      else if (k === 'leech') updateLeech(this, e, dt);
    }
    this.towForces(dt);
    this.integrate(dt);
    this.planetCollisions();
    this.worldBounds();
    this.rebuildHash();
    this.contacts(dt);
    this.bolts(dt);
    this.delivery();
    this.reinforcements(dt);
    this.checkSector();

    this.input.burnPressed = false;
    this.input.releasePressed = false;
    this.ecs.flush((e) => {
      const b = this.bundles.get(e);
      if (b) {
        this.bundles.delete(e);
        this.boltPool.release(b);
      }
    });
  }

  // ---- ship ---------------------------------------------------------------------------------------

  private applyBurn(): void {
    const s = this.shipC;
    const t = this.tf.get(this.ship)!;
    const b = this.body.get(this.ship)!;
    const m = 1 + 0.22 * s.towCount;
    b.vx += (Math.cos(t.a) * Tuning.burnImpulse) / m;
    b.vy += (Math.sin(t.a) * Tuning.burnImpulse) / m;
    s.fuel = Math.max(0, s.fuel - SHIP.burnCost);
    this.stats.fuelBurned += SHIP.burnCost;
    s.burnCd = SHIP.burnCooldown;
    s.burnLeft = SHIP.burnTime;
    s.burnBuf = 0;
    this.bus.emit('BURN', { x: t.x, y: t.y, a: t.a });
  }

  private shipSystem(dt: number): void {
    const s = this.shipC;
    const inp = this.input;
    const t = this.tf.get(this.ship)!;
    const b = this.body.get(this.ship)!;
    const h = this.health.get(this.ship)!;
    s.fsm.update(dt);
    h.hp = s.hull;
    h.flash = Math.max(0, h.flash - dt);
    b.drag = Tuning.drag;
    if (s.fsm.state === 'Dead') {
      s.thrusting = false;
      return;
    }

    s.fireCd -= dt;
    s.burnCd -= dt;
    s.invuln -= dt;
    s.stun -= dt;
    s.burnBuf -= dt;
    s.fireBuf -= dt;
    if (inp.burnPressed) s.burnBuf = 0.15;
    if (inp.fire) s.fireBuf = 0.1;
    if (inp.releasePressed) this.releaseAll();

    const speed = Math.hypot(b.vx, b.vy);
    const inBeacon = Math.hypot(t.x - this.beacon.x, t.y - this.beacon.y) < this.beacon.r;
    const fsm = s.fsm;

    switch (fsm.state) {
      case 'Stunned':
        if (s.stun <= 0) fsm.request('Drift');
        break;
      case 'Burn':
        s.burnLeft -= dt;
        if (s.burnLeft <= 0) fsm.request('Drift');
        break;
      case 'Docked':
        if (s.burnBuf > 0 && s.burnCd <= 0 && s.fuel >= SHIP.burnCost) fsm.request('Burn');
        else if (inp.thrust || speed > SHIP.dockSpeed * 1.4 || !inBeacon) fsm.request('Drift');
        break;
      default: {
        if (s.burnBuf > 0 && s.burnCd <= 0 && s.fuel >= SHIP.burnCost) fsm.request('Burn');
        else if (inBeacon && speed < SHIP.dockSpeed && !inp.thrust) fsm.request('Docked');
        else if (inp.thrust && s.fuel > 0) fsm.request('Thrust');
        else fsm.request('Drift');
      }
    }

    const st = fsm.state as ShipState;
    // Rotation: smoothed angular velocity so steering feels weighty but responsive.
    if (st !== 'Stunned') {
      const want = ((inp.right ? 1 : 0) - (inp.left ? 1 : 0)) * Tuning.turnRate;
      s.av += (want - s.av) * Math.min(1, 14 * dt);
    } else {
      s.av *= Math.exp(-2 * dt);
    }
    t.a += s.av * dt;

    s.thrusting = st === 'Thrust';
    if (st === 'Thrust') {
      const m = 1 + 0.22 * s.towCount;
      b.vx += (Math.cos(t.a) * Tuning.thrust * dt) / m;
      b.vy += (Math.sin(t.a) * Tuning.thrust * dt) / m;
      const use = Tuning.fuelUse * dt;
      s.fuel = Math.max(0, s.fuel - use);
      this.stats.fuelBurned += use;
    }
    if (st === 'Docked') {
      const k = Math.exp(-3 * dt);
      b.vx *= k;
      b.vy *= k;
      s.fuel = Math.min(SHIP.fuel, s.fuel + SHIP.dockFuelRate * dt);
      s.hull = Math.min(SHIP.hull, s.hull + SHIP.dockRepairRate * dt);
    }
    if (s.fuel < 20 && !this.lowFuelWarned) {
      this.lowFuelWarned = true;
      this.bus.emit('LOW_FUEL', {});
    }
    if (s.fuel > 30) this.lowFuelWarned = false;

    if (s.fireBuf > 0 && s.fireCd <= 0 && st !== 'Stunned') {
      const nx = Math.cos(t.a);
      const ny = Math.sin(t.a);
      this.spawnBolt(t.x + nx * 18, t.y + ny * 18, t.a, SHIP.boltSpeed, false, SHIP.boltDamage, SHIP.boltLife, b.vx, b.vy);
      s.fireCd = Tuning.fireCooldown;
      s.fireBuf = 0;
    }

    // Out of fuel and not docked: a countdown to being declared stranded.
    if (s.fuel <= 0 && st !== 'Docked') s.strand += dt;
    else s.strand = 0;
    if (s.strand > 10) {
      s.fsm.request('Dead');
      this.bus.emit('EXPLOSION', { x: t.x, y: t.y, r: 40 });
      this.finish('lost', 'stranded');
    }
  }

  // ---- physics ------------------------------------------------------------------------------------

  private integrate(dt: number): void {
    for (const [e, b] of this.body) {
      const t = this.tf.get(e)!;
      const pc = this.pod.get(e);
      if (pc) pc.grabCd -= dt;
      if (pc && pc.mode === 'carried') continue;
      if (b.gravity > 0) {
        accelAt(this.planets, t.x, t.y, this.acc);
        b.vx += this.acc.x * b.gravity * dt;
        b.vy += this.acc.y * b.gravity * dt;
      }
      if (b.drag > 0) {
        const k = Math.exp(-b.drag * dt);
        b.vx *= k;
        b.vy *= k;
      }
      t.x += b.vx * dt;
      t.y += b.vy * dt;
    }
  }

  private planetCollisions(): void {
    for (const [e, b] of this.body) {
      const k = this.kind.get(e)!;
      if (k === 'pbolt' || k === 'ebolt') continue;
      const pc = this.pod.get(e);
      if (pc && pc.mode === 'carried') continue;
      const t = this.tf.get(e)!;
      for (const p of this.planets) {
        const dx = t.x - p.x;
        const dy = t.y - p.y;
        const d = Math.hypot(dx, dy) || 0.001;
        const min = p.r + b.radius;
        if (d >= min) continue;
        const nx = dx / d;
        const ny = dy / d;
        t.x = p.x + nx * min;
        t.y = p.y + ny * min;
        const vn = b.vx * nx + b.vy * ny;
        if (vn >= 0) continue;
        const impact = -vn;
        if (k === 'ship') {
          const over = impact - SHIP.safeImpact;
          if (over > 0) {
            const dmg = Math.round(Math.min(55, 8 + over * 0.28));
            this.stats.crashes++;
            this.bus.emit('CRASH', { x: t.x, y: t.y, speed: impact, damage: dmg });
            this.damageShip(dmg, t.x, t.y, true);
          }
          // Bounce, with a bit of tangential scrub.
          const rest = over > 0 ? 0.45 : 0.1;
          b.vx -= (1 + rest) * vn * nx;
          b.vy -= (1 + rest) * vn * ny;
          const tx = -ny;
          const ty = nx;
          const vt = b.vx * tx + b.vy * ty;
          b.vx -= vt * 0.12 * tx;
          b.vy -= vt * 0.12 * ty;
        } else if (k === 'pod') {
          if (impact > POD.crashSpeed) this.losePod(e, 'crash');
          else {
            b.vx -= 1.4 * vn * nx;
            b.vy -= 1.4 * vn * ny;
          }
        } else if (impact > 210 && k !== 'mine') {
          this.destroyEnemy(e, false);
        } else {
          b.vx -= 1.35 * vn * nx;
          b.vy -= 1.35 * vn * ny;
        }
      }
    }
  }

  private worldBounds(): void {
    for (const [e, b] of this.body) {
      const k = this.kind.get(e)!;
      if (k === 'pbolt' || k === 'ebolt') continue;
      const pc = this.pod.get(e);
      if (pc && pc.mode === 'carried') continue;
      if (k === 'leech' && this.brain.get(e)?.fsm.state === 'Carry') continue;
      const t = this.tf.get(e)!;
      const r = b.radius;
      if (t.x < r) {
        t.x = r;
        b.vx = Math.abs(b.vx) * 0.6;
      } else if (t.x > WORLD_W - r) {
        t.x = WORLD_W - r;
        b.vx = -Math.abs(b.vx) * 0.6;
      }
      if (t.y < r) {
        t.y = r;
        b.vy = Math.abs(b.vy) * 0.6;
      } else if (t.y > WORLD_H - r) {
        t.y = WORLD_H - r;
        b.vy = -Math.abs(b.vy) * 0.6;
      }
    }
  }

  private rebuildHash(): void {
    this.hash.clear();
    for (const [e, k] of this.kind) {
      if (k === 'pbolt' || k === 'ebolt' || !this.ecs.isLive(e)) continue;
      const pc = this.pod.get(e);
      if (pc && pc.mode === 'carried') continue;
      const t = this.tf.get(e)!;
      this.hash.insert(e, t.x, t.y, this.body.get(e)!.radius);
    }
  }

  /** Ship contacts: tethering pods, ramming, mine proximity. */
  private contacts(dt: number): void {
    void dt;
    if (!this.shipAlive()) return;
    const st = this.tf.get(this.ship)!;
    const sb = this.body.get(this.ship)!;
    this.hash.query(st.x, st.y, SHIP.grabRadius + 30, this.buf);
    for (const id of this.buf) {
      if (id === this.ship || !this.ecs.isLive(id)) continue;
      const k = this.kind.get(id)!;
      const t = this.tf.get(id)!;
      const b = this.body.get(id)!;
      const d = Math.hypot(t.x - st.x, t.y - st.y);
      if (k === 'pod') {
        const pc = this.pod.get(id)!;
        if (pc.mode === 'free' && pc.grabCd <= 0 && d < SHIP.grabRadius + b.radius && this.chain.length < SHIP.maxTow) {
          pc.mode = 'towed';
          pc.link = this.chain.length === 0 ? this.ship : this.chain[this.chain.length - 1]!;
          this.chain.push(id);
          this.shipC.towCount = this.chain.length;
          this.bus.emit('POD_GRAB', { x: t.x, y: t.y });
        }
      } else if (k === 'mine') {
        if (d < b.radius + sb.radius) this.detonate(id);
      } else if (k === 'interceptor') {
        if (d < b.radius + sb.radius) {
          const nx = (st.x - t.x) / (d || 1);
          const ny = (st.y - t.y) / (d || 1);
          sb.vx += nx * 160;
          sb.vy += ny * 160;
          b.vx -= nx * 100;
          b.vy -= ny * 100;
          this.damageShip(6, st.x, st.y, false);
        }
      }
    }
  }

  private bolts(dt: number): void {
    const st = this.tf.get(this.ship)!;
    for (const [e, bc] of this.bolt) {
      if (!this.ecs.isLive(e)) continue;
      const t = this.tf.get(e)!;
      const life = this.life.get(e)!;
      life.t -= dt;
      if (life.t <= 0) {
        this.ecs.kill(e);
        continue;
      }
      t.a = Math.atan2(this.body.get(e)!.vy, this.body.get(e)!.vx);
      let spent = false;
      for (const p of this.planets) {
        if (Math.hypot(t.x - p.x, t.y - p.y) < p.r) {
          this.bus.emit('IMPACT', { x: t.x, y: t.y });
          spent = true;
          break;
        }
      }
      if (!spent && (t.x < 0 || t.y < 0 || t.x > WORLD_W || t.y > WORLD_H)) spent = true;
      if (!spent && bc.hostile) {
        if (this.shipAlive() && Math.hypot(t.x - st.x, t.y - st.y) < SHIP.radius + 4) {
          this.damageShip(bc.damage, t.x, t.y, false);
          spent = true;
        }
      } else if (!spent) {
        this.hash.query(t.x, t.y, 30, this.buf);
        for (const id of this.buf) {
          if (!this.ecs.isLive(id)) continue;
          const k = this.kind.get(id);
          if (k !== 'mine' && k !== 'interceptor' && k !== 'leech') continue;
          const ot = this.tf.get(id)!;
          const ob = this.body.get(id)!;
          if (Math.hypot(ot.x - t.x, ot.y - t.y) < ob.radius + 4) {
            this.stats.shotsHit++;
            this.damageEnemy(id, bc.damage);
            spent = true;
            break;
          }
        }
      }
      if (spent) this.ecs.kill(e);
    }
  }

  private delivery(): void {
    const bc = this.beacon;
    for (const [e, pc] of this.pod) {
      if (!this.ecs.isLive(e) || pc.mode === 'carried') continue;
      const t = this.tf.get(e)!;
      if (Math.hypot(t.x - bc.x, t.y - bc.y) > bc.r * 0.85) continue;
      this.removeFromChain(e);
      this.ecs.kill(e);
      this.podsDelivered++;
      this.stats.podsDelivered++;
      this.stats.score += 100;
      this.shipC.fuel = Math.min(SHIP.fuel, this.shipC.fuel + POD.deliverFuel);
      this.bus.emit('POD_DELIVER', { x: t.x, y: t.y, total: this.podsDelivered });
    }
  }

  private reinforcements(dt: number): void {
    this.reinforce -= dt * Tuning.enemyRate;
    if (this.reinforce > 0) return;
    this.reinforce = Math.max(14, 34 - this.sector * 3);
    if (this.countKind('interceptor') < 1 + this.sector) this.spawnAtFarPoint('interceptor');
  }

  private checkSector(): void {
    if (this.phase !== 'play') return;
    if (this.podsDelivered + this.podsRemaining < this.quota) {
      this.finish('lost', 'contract');
      return;
    }
    if (this.podsDelivered >= this.quota) {
      this.stats.score += 250 * this.sector;
      if (this.sector >= MAX_SECTOR) {
        this.phase = 'won';
        this.bus.emit('VICTORY', {});
      } else {
        this.phase = 'clear';
        this.bus.emit('SECTOR_CLEAR', { sector: this.sector });
      }
    }
  }

  private finish(phase: 'lost', reason: GameOverReason): void {
    if (this.phase !== 'play') return;
    this.phase = phase;
    this.failReason = reason;
    this.bus.emit('GAME_OVER', { reason });
  }
}
