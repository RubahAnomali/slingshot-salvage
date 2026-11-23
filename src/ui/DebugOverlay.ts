import type { DebugFlags } from '../render/Renderer';
import { DEFAULT_TUNING, Tuning, TUNING_META } from '../sim/config';
import type { Sim } from '../sim/World';
import type { Fx } from '../render/Fx';

export interface DebugInfo {
  fps: number;
  frameMs: number;
  simMs: number;
  stepsLastFrame: number;
}

/** DOM debug and telemetry panel (F1 or `). Sliders write straight into the live Tuning object. */
export class DebugOverlay {
  readonly flags: DebugFlags = { on: false, hitboxes: true, vectors: true, grid: false, labels: true };
  private readonly root: HTMLDivElement;
  private readonly readout: HTMLPreElement;
  private readonly sliders = new Map<string, { input: HTMLInputElement; value: HTMLSpanElement }>();
  private acc = 0;

  constructor(
    host: HTMLElement,
    private readonly actions: { spawn: (k: 'mine' | 'interceptor' | 'leech') => void; refuel: () => void },
  ) {
    this.root = document.createElement('div');
    this.root.id = 'debug';
    this.root.hidden = true;
    this.root.innerHTML = '<h3>DEBUG / TELEMETRY</h3>';
    this.readout = document.createElement('pre');
    this.root.appendChild(this.readout);

    const flagsBox = document.createElement('div');
    flagsBox.className = 'row';
    (['hitboxes', 'vectors', 'grid', 'labels'] as const).forEach((k) => {
      const l = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.flags[k];
      cb.addEventListener('change', () => {
        this.flags[k] = cb.checked;
      });
      l.append(cb, k);
      flagsBox.appendChild(l);
    });
    this.root.appendChild(flagsBox);

    for (const m of TUNING_META) {
      const row = document.createElement('label');
      row.className = 'slider';
      const name = document.createElement('span');
      name.textContent = m.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(m.min);
      input.max = String(m.max);
      input.step = String(m.step);
      input.value = String(Tuning[m.key]);
      const value = document.createElement('span');
      value.textContent = String(Tuning[m.key]);
      input.addEventListener('input', () => {
        Tuning[m.key] = Number(input.value);
        value.textContent = input.value;
      });
      row.append(name, input, value);
      this.root.appendChild(row);
      this.sliders.set(m.key, { input, value });
    }

    const btns = document.createElement('div');
    btns.className = 'row';
    const mk = (label: string, fn: () => void): void => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', (e) => {
        fn();
        (e.currentTarget as HTMLButtonElement).blur();
      });
      btns.appendChild(b);
    };
    mk('+mine', () => this.actions.spawn('mine'));
    mk('+interceptor', () => this.actions.spawn('interceptor'));
    mk('+leech', () => this.actions.spawn('leech'));
    mk('refuel', () => this.actions.refuel());
    mk('reset tuning', () => this.resetTuning());
    this.root.appendChild(btns);
    host.appendChild(this.root);
  }

  toggle(): void {
    this.flags.on = !this.flags.on;
    this.root.hidden = !this.flags.on;
  }

  resetTuning(): void {
    Object.assign(Tuning, DEFAULT_TUNING);
    for (const m of TUNING_META) {
      const s = this.sliders.get(m.key)!;
      s.input.value = String(Tuning[m.key]);
      s.value.textContent = String(Tuning[m.key]);
    }
  }

  /** Throttled text refresh (about 5 Hz) so the overlay doesn't cost frame time. */
  update(dt: number, sim: Sim, fx: Fx, info: DebugInfo): void {
    if (!this.flags.on) return;
    this.acc += dt;
    if (this.acc < 0.2) return;
    this.acc = 0;
    const s = sim.shipC;
    const b = sim.body.get(sim.ship)!;
    const brains: string[] = [];
    for (const [e, br] of sim.brain) {
      if (brains.length >= 6) break;
      brains.push(`  #${e} ${sim.kind.get(e)!.padEnd(11)} ${br.fsm.state.padEnd(8)} ${br.note}`);
    }
    this.readout.textContent = [
      `fps ${info.fps.toFixed(0)}  frame ${info.frameMs.toFixed(1)}ms  sim ${info.simMs.toFixed(2)}ms  steps ${info.stepsLastFrame}`,
      `entities ${sim.ecs.count}  bolts ${sim.bolt.size}  pods ${sim.pod.size}`,
      `bolt pool free ${sim.boltPool.available} / allocated ${sim.boltPool.allocated}`,
      `particles ${fx.live.length}  pool free ${fx.pool.available} / allocated ${fx.pool.allocated}`,
      `hash cells ${sim.hash.cellCount}   tick ${sim.tick}`,
      `ship ${s.fsm.state} (${s.fsm.time.toFixed(2)}s)  rejected ${s.fsm.rejected}`,
      `  history ${s.fsm.history.join(' > ')}`,
      `  speed ${Math.hypot(b.vx, b.vy).toFixed(0)}  fuel ${s.fuel.toFixed(0)}  tow ${s.towCount}  strand ${s.strand.toFixed(1)}`,
      `reinforce in ${Math.max(0, sim.reinforce).toFixed(0)}s`,
      'brains:',
      ...brains,
    ].join('\n');
  }
}
