/**
 * A small TTL cache for per-request access checks (is this session still
 * live, is this organization still active). Each miss costs a TCP hop and a
 * database query, so answers are kept for `ttlMs`, and concurrent misses for
 * the same key share one lookup instead of each paying for their own.
 */
export class AccessStateCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    /** Bound on entries; the oldest are dropped first once it's reached. */
    private readonly maxEntries = 10000,
  ) {}

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const lookup = load()
      .then((value) => {
        if (this.entries.size >= this.maxEntries) {
          const oldest = this.entries.keys().next().value;
          if (oldest !== undefined) this.entries.delete(oldest);
        }
        this.entries.set(key, { value, at: Date.now() });
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, lookup);
    return lookup;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
