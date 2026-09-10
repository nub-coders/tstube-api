/**
 * Bounded LRU cache with optional TTL — port of utils/bounded_cache.py.
 *
 * Single-event-loop use only (no internal locking), exactly like the Python
 * original: MEMORY_CACHE / LOCKS, the stream-job memo/events and refresh locks.
 */

const MISSING = Symbol('missing');

interface Entry<V> {
  value: V;
  expiry: number | null;
}

export class BoundedCache<V = unknown> {
  readonly maxsize: number;
  readonly ttl: number | null;
  private data = new Map<string, Entry<V>>();

  constructor(maxsize = 1000, ttl: number | null = null) {
    this.maxsize = maxsize;
    this.ttl = ttl;
  }

  /** Return the live value, or MISSING (evicting an expired entry). */
  private live(key: string): V | typeof MISSING {
    const item = this.data.get(key);
    if (item === undefined) return MISSING;
    if (item.expiry !== null && item.expiry < Date.now() / 1000) {
      this.data.delete(key);
      return MISSING;
    }
    // move_to_end
    this.data.delete(key);
    this.data.set(key, item);
    return item.value;
  }

  has(key: string): boolean {
    return this.live(key) !== MISSING;
  }

  get(key: string, def: V | undefined = undefined): V | undefined {
    const v = this.live(key);
    return v === MISSING ? def : v;
  }

  set(key: string, value: V): void {
    if (this.data.has(key)) this.data.delete(key);
    this.data.set(key, {
      value,
      expiry: this.ttl ? Date.now() / 1000 + this.ttl : null,
    });
    while (this.data.size > this.maxsize) {
      const oldest = this.data.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.data.delete(oldest);
    }
  }

  pop(key: string): V | undefined;
  pop(key: string, def: V): V;
  pop(key: string, def?: V): V | undefined {
    const item = this.data.get(key);
    this.data.delete(key);
    if (item === undefined) return def;
    if (item.expiry !== null && item.expiry < Date.now() / 1000) return def;
    return item.value;
  }

  delete(key: string): void {
    this.data.delete(key);
  }

  setdefault(key: string, def: V): V {
    const v = this.live(key);
    if (v === MISSING) {
      this.set(key, def);
      return def;
    }
    return v;
  }

  clear(): void {
    this.data.clear();
  }

  get size(): number {
    return this.data.size;
  }
}
