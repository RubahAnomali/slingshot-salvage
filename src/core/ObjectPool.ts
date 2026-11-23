/** Fixed-purpose object pool: acquire() reuses a released object or builds a new one. */
export class ObjectPool<T> {
  private readonly free: T[] = [];
  private created = 0;

  constructor(
    private readonly make: () => T,
    private readonly reset: (o: T) => void,
    prewarm = 0,
  ) {
    for (let i = 0; i < prewarm; i++) this.free.push(this.build());
  }

  private build(): T {
    this.created++;
    return this.make();
  }

  acquire(): T {
    const o = this.free.pop() ?? this.build();
    this.reset(o);
    return o;
  }

  release(o: T): void {
    this.free.push(o);
  }

  get available(): number {
    return this.free.length;
  }

  /** Total objects ever allocated. If this keeps growing, something is leaking. */
  get allocated(): number {
    return this.created;
  }
}
