export type Entity = number;

/** Sparse component storage keyed by entity id. */
export class Store<T> {
  readonly map = new Map<Entity, T>();
  get(e: Entity): T | undefined {
    return this.map.get(e);
  }
  set(e: Entity, c: T): void {
    this.map.set(e, c);
  }
  has(e: Entity): boolean {
    return this.map.has(e);
  }
  get size(): number {
    return this.map.size;
  }
  keys(): IterableIterator<Entity> {
    return this.map.keys();
  }
  [Symbol.iterator](): IterableIterator<[Entity, T]> {
    return this.map.entries();
  }
}

/**
 * A deliberately small Entity-Component-System. Entities are plain integers, components live in
 * per-type stores, and systems are functions that iterate stores.
 *
 * Destruction is deferred: `kill()` marks an entity and `flush()` (called once per tick, after all
 * systems ran) removes it from every store. Ids are never reused within a world, so a stale reference
 * (a tether pointing at a dead pod, say) can only ever fail an `isLive` check; it can't alias a new entity.
 */
export class Ecs {
  private nextId = 1;
  private readonly alive = new Set<Entity>();
  private readonly pending = new Set<Entity>();
  private readonly stores: Store<unknown>[] = [];

  store<T>(): Store<T> {
    const s = new Store<T>();
    this.stores.push(s as Store<unknown>);
    return s;
  }

  create(): Entity {
    const e = this.nextId++;
    this.alive.add(e);
    return e;
  }

  kill(e: Entity): void {
    if (this.alive.has(e)) this.pending.add(e);
  }

  isLive(e: Entity): boolean {
    return this.alive.has(e) && !this.pending.has(e);
  }

  /** Remove everything marked with kill(). Returns the killed ids so callers can recycle pooled parts. */
  flush(onRemoved?: (e: Entity) => void): void {
    if (this.pending.size === 0) return;
    for (const e of this.pending) {
      onRemoved?.(e);
      for (const s of this.stores) s.map.delete(e);
      this.alive.delete(e);
    }
    this.pending.clear();
  }

  get count(): number {
    return this.alive.size - this.pending.size;
  }

  clear(): void {
    for (const s of this.stores) s.map.clear();
    this.alive.clear();
    this.pending.clear();
  }
}
