import type { EventBus } from '../core/EventBus';
import type { SimEvents } from '../sim/types';

/** Fully procedural audio: oscillators and filtered noise. No sample files. */
export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private thrustSrc: AudioBufferSourceNode | null = null;
  private thrustGain: GainNode | null = null;
  private thrustFilter: BiquadFilterNode | null = null;
  muted = false;
  private readonly off: (() => void)[] = [];

  /** Create the AudioContext on first user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
    } catch {
      return;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 1.5;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startThrust();
  }

  toggleMute(): void {
    this.muted = !this.muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, this.ctx.currentTime, 0.02);
  }

  bind(bus: EventBus<SimEvents>): void {
    const on = <K extends keyof SimEvents>(k: K, f: (p: SimEvents[K]) => void): void => {
      this.off.push(bus.on(k, f));
    };
    on('SHOT', (e) => (e.hostile ? this.tone(190, 90, 0.16, 'sawtooth', 0.12) : this.tone(880, 260, 0.1, 'square', 0.09)));
    on('HIT', (e) => {
      if (e.kind === 'ship') {
        this.burst(0.2, 900, 0.3);
        this.tone(120, 60, 0.22, 'square', 0.15);
      } else this.burst(0.06, 2400, 0.14);
    });
    on('IMPACT', () => this.burst(0.05, 3000, 0.06));
    on('EXPLOSION', () => {
      this.burst(0.7, 500, 0.5);
      this.tone(110, 28, 0.6, 'sine', 0.4);
    });
    on('CRASH', () => {
      this.burst(0.35, 300, 0.45);
      this.tone(70, 35, 0.35, 'sine', 0.35);
    });
    on('BURN', () => this.sweep(300, 1500, 0.28));
    on('POD_GRAB', () => {
      this.tone(520, 520, 0.07, 'triangle', 0.2);
      this.tone(780, 780, 0.1, 'triangle', 0.2, 0.07);
    });
    on('POD_RELEASE', () => this.tone(300, 180, 0.12, 'triangle', 0.15));
    on('POD_DELIVER', () => {
      [523, 659, 784, 1047].forEach((f, i) => this.tone(f, f, 0.14, 'triangle', 0.22, i * 0.07));
    });
    on('POD_LOST', () => {
      this.tone(330, 110, 0.4, 'sawtooth', 0.2);
    });
    on('ENEMY_DOWN', () => {
      this.burst(0.2, 1400, 0.25);
      this.tone(240, 80, 0.2, 'square', 0.12);
    });
    on('WARN', () => {
      this.tone(960, 960, 0.07, 'square', 0.12);
      this.tone(960, 960, 0.07, 'square', 0.12, 0.12);
    });
    on('DOCK', (e) => {
      if (e.on) {
        this.tone(440, 440, 0.12, 'sine', 0.2);
        this.tone(660, 660, 0.18, 'sine', 0.2, 0.1);
      }
    });
    on('LOW_FUEL', () => {
      for (let i = 0; i < 3; i++) this.tone(300, 300, 0.1, 'square', 0.14, i * 0.16);
    });
    on('SECTOR_START', () => this.sweep(200, 800, 0.4));
    on('SECTOR_CLEAR', () => [392, 494, 587, 784].forEach((f, i) => this.tone(f, f, 0.3, 'triangle', 0.25, i * 0.12)));
    on('VICTORY', () => [392, 494, 587, 784, 988, 1175].forEach((f, i) => this.tone(f, f, 0.4, 'triangle', 0.25, i * 0.14)));
    on('GAME_OVER', () => [330, 262, 196, 131].forEach((f, i) => this.tone(f, f * 0.9, 0.4, 'sawtooth', 0.2, i * 0.2)));
    on('THRUST', (e) => this.setThrust(e.on));
  }

  dispose(): void {
    for (const o of this.off) o();
    this.off.length = 0;
    this.setThrust(false);
    this.thrustSrc?.stop();
    this.thrustSrc = null;
  }

  private startThrust(): void {
    if (!this.ctx || !this.noise || !this.master) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 380;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    this.thrustSrc = src;
    this.thrustGain = g;
    this.thrustFilter = f;
  }

  setThrust(on: boolean): void {
    if (!this.ctx || !this.thrustGain || !this.thrustFilter) return;
    const t = this.ctx.currentTime;
    this.thrustGain.gain.setTargetAtTime(on ? 0.28 : 0, t, on ? 0.04 : 0.09);
    this.thrustFilter.frequency.setTargetAtTime(on ? 620 : 300, t, 0.1);
  }

  private tone(f0: number, f1: number, dur: number, type: OscillatorType, vol: number, delay = 0): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private burst(dur: number, cutoff: number, vol: number): void {
    if (!this.ctx || !this.master || !this.noise) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * 0.15), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random());
    s.stop(t + dur + 0.02);
  }

  private sweep(from: number, to: number, dur: number): void {
    if (!this.ctx || !this.master || !this.noise) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0008, t);
    g.gain.linearRampToValueAtTime(0.35, t + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random());
    s.stop(t + dur + 0.02);
  }

  click(): void {
    this.tone(700, 500, 0.05, 'square', 0.1);
  }
}
