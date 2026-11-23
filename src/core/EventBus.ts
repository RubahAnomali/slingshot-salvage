// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (payload: any) => void;

/** Strongly typed publish/subscribe bus. `E` maps event names to payload types. */
export class EventBus<E> {
  private readonly handlers = new Map<keyof E, Set<Handler>>();

  on<K extends keyof E>(event: K, handler: (payload: E[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    const s = set;
    s.add(handler);
    return () => {
      s.delete(handler);
    };
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) h(payload);
  }

  listenerCount(): number {
    let n = 0;
    for (const s of this.handlers.values()) n += s.size;
    return n;
  }

  clear(): void {
    this.handlers.clear();
  }
}
