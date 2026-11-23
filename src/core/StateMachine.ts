export interface StateHooks<S extends string> {
  enter?(from: S): void;
  exit?(to: S): void;
}

/**
 * Explicit finite state machine. Legal transitions are declared in an adjacency table, so an illegal
 * `request()` is rejected (and counted) instead of silently corrupting behaviour.
 */
export class StateMachine<S extends string> {
  state: S;
  /** Seconds spent in the current state. */
  time = 0;
  rejected = 0;
  readonly history: S[] = [];

  constructor(
    initial: S,
    private readonly allowed: Readonly<Record<S, readonly S[]>>,
    private readonly hooks: Partial<Record<S, StateHooks<S>>> = {},
  ) {
    this.state = initial;
  }

  can(to: S): boolean {
    return this.allowed[this.state].includes(to);
  }

  request(to: S): boolean {
    if (to === this.state) return true;
    if (!this.can(to)) {
      this.rejected++;
      return false;
    }
    const from = this.state;
    this.hooks[from]?.exit?.(to);
    this.state = to;
    this.time = 0;
    this.history.push(to);
    if (this.history.length > 8) this.history.shift();
    this.hooks[to]?.enter?.(from);
    return true;
  }

  update(dt: number): void {
    this.time += dt;
  }

  is(...s: S[]): boolean {
    return s.includes(this.state);
  }
}
