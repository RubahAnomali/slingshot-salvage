import { SoundEngine } from './audio/SoundEngine';
import { EventBus } from './core/EventBus';
import { Fx } from './render/Fx';
import { Renderer } from './render/Renderer';
import { SHIP, STEP } from './sim/config';
import type { SimEvents } from './sim/types';
import { Sim } from './sim/World';
import { DebugOverlay } from './ui/DebugOverlay';
import { Hud, type Screen } from './ui/Hud';
import { Input } from './ui/Input';

const MAX_STEPS_PER_FRAME = 6;

/**
 * Composition root. Owns the frame loop (fixed-timestep accumulator, dt clamp, hit-stop), DOM input and
 * screen flow. Every subscription is made once here or in a constructor, so `restart()` never stacks listeners.
 */
export class Game {
  readonly bus = new EventBus<SimEvents>();
  readonly sim = new Sim(this.bus);
  readonly fx = new Fx(this.bus);
  readonly sound = new SoundEngine();
  readonly input = new Input();
  readonly renderer: Renderer;
  readonly hud = new Hud();
  readonly debug: DebugOverlay;

  screen: Screen = 'title';
  private acc = 0;
  private freeze = 0;
  private last = 0;
  private time = 0;
  private raf = 0;
  private running = false;
  private fps = 60;
  private frameMs = 16;
  private simMs = 0;
  private steps = 0;
  private exhaustAcc = 0;
  private readonly cleanups: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement, overlayHost: HTMLElement) {
    this.renderer = new Renderer(canvas);
    this.sound.bind(this.bus);
    this.input.attach();
    this.debug = new DebugOverlay(overlayHost, {
      spawn: (k) => {
        const st = this.sim.tf.get(this.sim.ship)!;
        const a = Math.random() * Math.PI * 2;
        this.sim.spawnEnemy(k, st.x + Math.cos(a) * 520, st.y + Math.sin(a) * 520);
      },
      refuel: () => {
        this.sim.shipC.fuel = SHIP.fuel;
        this.sim.shipC.hull = SHIP.hull;
      },
    });
    this.sim.newRun(1);
    this.renderer.snapCamera(this.sim);

    this.listen<KeyboardEvent>(window, 'keydown', (e) => this.onKey(e));
    this.listen<MouseEvent>(canvas, 'mousedown', (e) => this.onMouse(e));
    this.listen(document, 'visibilitychange', () => {
      if (document.hidden && this.screen === 'play') this.screen = 'paused';
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
    this.input.dispose();
    this.fx.dispose();
    this.sound.dispose();
    this.bus.clear();
  }

  /** Fresh contract: new seed, new sim state, no stale particles, timers or input edges. */
  restart(): void {
    this.sim.newRun((Math.random() * 0xffff) | 0 || 1);
    this.fx.clear();
    this.input.reset();
    this.acc = 0;
    this.freeze = 0;
    this.renderer.snapCamera(this.sim);
    this.screen = 'play';
  }

  private listen<T extends Event>(t: EventTarget, type: string, fn: (e: T) => void): void {
    const h = fn as unknown as EventListener;
    t.addEventListener(type, h);
    this.cleanups.push(() => t.removeEventListener(type, h));
  }

  // ---- input --------------------------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    if (['Space', 'Tab', 'F1'].includes(e.code)) e.preventDefault();
    this.sound.unlock();
    if (e.code === 'F1' || e.code === 'Backquote') {
      if (!e.repeat) this.debug.toggle();
      return;
    }
    if (e.repeat) return;
    if (e.code === 'KeyM') return this.sound.toggleMute();
    if (this.screen === 'title') {
      if (e.code === 'Enter' || e.code === 'Space') this.restart();
      return;
    }
    if (e.code === 'KeyR') return this.restart();
    const phase = this.sim.phase;
    if (phase === 'clear') {
      if (e.code === 'Enter') this.nextSector();
      return;
    }
    if (phase === 'won' || phase === 'lost') {
      if (e.code === 'Enter') this.restart();
      return;
    }
    if (e.code === 'KeyP' || e.code === 'Escape') {
      this.screen = this.screen === 'paused' ? 'play' : 'paused';
      this.input.reset();
    }
  }

  private nextSector(): void {
    this.sim.nextSector();
    this.fx.clear();
    this.input.reset();
    this.acc = 0;
    this.renderer.snapCamera(this.sim);
  }

  private onMouse(e: MouseEvent): void {
    this.sound.unlock();
    const p = this.renderer.toLogical(e.clientX, e.clientY);
    const id = this.hud.hit(p.x, p.y);
    if (!id) return;
    this.sound.click();
    if (id === 'start' || id === 'restart') this.restart();
    else if (id === 'resume') this.screen = 'play';
    else if (id === 'next') this.nextSector();
  }

  // ---- loop ---------------------------------------------------------------------------------------

  private frame(now: number): void {
    if (!this.running) return;
    const raw = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    const dt = Math.min(raw, 0.05); // clamp: a stalled tab must not fire a burst of catch-up steps
    this.time += dt;
    this.frameMs += (raw * 1000 - this.frameMs) * 0.1;
    this.fps += (1 / Math.max(raw, 1e-4) - this.fps) * 0.1;

    const c = this.renderer.begin();
    if (this.screen === 'title') {
      this.hud.drawTitle(c, this.time);
    } else {
      this.advance(dt);
      this.fx.update(this.freeze > 0 ? dt * 0.15 : dt);
      const alpha = this.screen === 'play' && this.sim.phase === 'play' ? this.acc / STEP : 1;
      this.exhaust(dt);
      this.renderer.updateCamera(this.sim, alpha, dt, this.fx);
      this.renderer.drawWorld(this.sim, this.fx, alpha, this.time, this.debug.flags);
      this.hud.drawHud(c, this.sim, this.time, this.sound.muted);
      if (this.sim.phase !== 'play') this.hud.drawEnd(c, this.sim, this.sim.phase);
      else if (this.screen === 'paused') this.hud.drawPause(c);
      this.debug.update(dt, this.sim, this.fx, { fps: this.fps, frameMs: this.frameMs, simMs: this.simMs, stepsLastFrame: this.steps });
    }
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /** Fixed-timestep accumulator with hit-stop. */
  private advance(dt: number): void {
    this.steps = 0;
    if (this.screen !== 'play') return;
    if (this.freeze > 0) {
      this.freeze -= dt;
      return;
    }
    this.acc += dt;
    const t0 = performance.now();
    while (this.acc >= STEP && this.steps < MAX_STEPS_PER_FRAME) {
      const i = this.input.state;
      const s = this.sim.input;
      s.left = i.left;
      s.right = i.right;
      s.thrust = i.thrust;
      s.fire = i.fire;
      s.burnPressed ||= i.burnPressed;
      s.releasePressed ||= i.releasePressed;
      i.burnPressed = false;
      i.releasePressed = false;
      this.sim.step(STEP);
      this.acc -= STEP;
      this.steps++;
    }
    if (this.steps === MAX_STEPS_PER_FRAME) this.acc = 0;
    this.simMs += ((performance.now() - t0) - this.simMs) * 0.1;
    const stop = this.fx.takeHitStop();
    if (stop > 0) this.freeze = Math.max(this.freeze, stop);
  }

  private exhaust(dt: number): void {
    if (this.screen !== 'play' || this.sim.phase !== 'play' || this.freeze > 0) return;
    const st = this.sim.shipC.fsm.state;
    if (st !== 'Thrust' && st !== 'Burn') return;
    this.exhaustAcc += dt * (st === 'Burn' ? 220 : 90);
    const t = this.sim.tf.get(this.sim.ship)!;
    const b = this.sim.body.get(this.sim.ship)!;
    while (this.exhaustAcc >= 1) {
      this.exhaustAcc -= 1;
      this.fx.exhaust(t.x - Math.cos(t.a) * 12, t.y - Math.sin(t.a) * 12, t.a, b.vx, b.vy);
    }
  }
}
