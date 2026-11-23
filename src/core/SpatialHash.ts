/**
 * Uniform-grid broadphase for circles. Rebuilt every tick; bucket arrays are reused so the steady state
 * allocates nothing.
 */
export class SpatialHash {
  private readonly cells = new Map<number, number[]>();
  private readonly used: number[][] = [];
  private readonly spare: number[][] = [];
  private stamp = 0;
  private readonly seen = new Map<number, number>();

  constructor(readonly cellSize: number) {}

  private key(cx: number, cy: number): number {
    return (cx + 512) * 1024 + (cy + 512);
  }

  clear(): void {
    for (const b of this.used) {
      b.length = 0;
      this.spare.push(b);
    }
    this.used.length = 0;
    this.cells.clear();
  }

  insert(id: number, x: number, y: number, r: number): void {
    const cs = this.cellSize;
    const x0 = Math.floor((x - r) / cs);
    const x1 = Math.floor((x + r) / cs);
    const y0 = Math.floor((y - r) / cs);
    const y1 = Math.floor((y + r) / cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = this.key(cx, cy);
        let b = this.cells.get(k);
        if (!b) {
          b = this.spare.pop() ?? [];
          this.cells.set(k, b);
          this.used.push(b);
        }
        b.push(id);
      }
    }
  }

  /** Collect candidate ids near a circle into `out` (deduplicated). */
  query(x: number, y: number, r: number, out: number[]): number[] {
    out.length = 0;
    this.stamp++;
    const cs = this.cellSize;
    const x0 = Math.floor((x - r) / cs);
    const x1 = Math.floor((x + r) / cs);
    const y0 = Math.floor((y - r) / cs);
    const y1 = Math.floor((y + r) / cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const b = this.cells.get(this.key(cx, cy));
        if (!b) continue;
        for (let i = 0; i < b.length; i++) {
          const id = b[i]!;
          if (this.seen.get(id) === this.stamp) continue;
          this.seen.set(id, this.stamp);
          out.push(id);
        }
      }
    }
    if (this.seen.size > 4096) this.seen.clear();
    return out;
  }

  get cellCount(): number {
    return this.cells.size;
  }
}
