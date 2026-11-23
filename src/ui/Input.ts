import type { InputState } from '../sim/types';

const LEFT = ['KeyA', 'ArrowLeft'];
const RIGHT = ['KeyD', 'ArrowRight'];
const THRUST = ['KeyW', 'ArrowUp'];
const FIRE = ['Space', 'KeyJ'];
const BURN = ['ShiftLeft', 'ShiftRight', 'KeyK'];
const RELEASE = ['KeyX'];

/**
 * Keyboard state. Held keys are level-triggered; burn and release are edge-triggered flags that the
 * game loop hands to the sim exactly once (the sim then buffers a burn press for a few frames).
 */
export class Input {
  readonly state: InputState = { left: false, right: false, thrust: false, fire: false, burnPressed: false, releasePressed: false };
  private readonly down = new Set<string>();
  private readonly cleanups: (() => void)[] = [];

  attach(): void {
    const kd = (e: KeyboardEvent): void => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (!e.repeat) {
        if (BURN.includes(e.code)) this.state.burnPressed = true;
        if (RELEASE.includes(e.code)) this.state.releasePressed = true;
      }
      this.down.add(e.code);
      this.sync();
    };
    const ku = (e: KeyboardEvent): void => {
      this.down.delete(e.code);
      this.sync();
    };
    const blur = (): void => this.reset();
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', blur);
    this.cleanups.push(
      () => window.removeEventListener('keydown', kd),
      () => window.removeEventListener('keyup', ku),
      () => window.removeEventListener('blur', blur),
    );
  }

  private sync(): void {
    const any = (codes: string[]): boolean => codes.some((c) => this.down.has(c));
    this.state.left = any(LEFT);
    this.state.right = any(RIGHT);
    this.state.thrust = any(THRUST);
    this.state.fire = any(FIRE);
  }

  reset(): void {
    this.down.clear();
    this.state.left = this.state.right = this.state.thrust = this.state.fire = false;
    this.state.burnPressed = this.state.releasePressed = false;
  }

  dispose(): void {
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
  }
}
