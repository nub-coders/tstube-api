/** Atomic Redis substitute shared by independent stream-job module instances. */
export class StreamJobRedis {
  readonly store = new Map<string, string>();
  readonly expires = new Map<string, number>();
  now = 0;
  failWrites = false;

  clear(): void {
    this.store.clear();
    this.expires.clear();
    this.now = 0;
    this.failWrites = false;
  }

  advance(ms: number): void {
    this.now += ms;
  }

  async get(key: string): Promise<string | null> {
    return this.read(key);
  }

  private read(key: string): string | null {
    if ((this.expires.get(key) ?? Infinity) <= this.now) {
      this.store.delete(key);
      this.expires.delete(key);
    }
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...rest: unknown[]): Promise<string | null> {
    if (this.failWrites) throw new Error('Redis unavailable after job claim');
    const opts = rest.map(String);
    const existing = this.read(key);
    if (opts.includes('NX') && existing !== null) return null;
    if (opts.includes('XX') && existing === null) return null;
    const ex = opts.indexOf('EX');
    this.write(key, value, ex < 0 ? undefined : Number(opts[ex + 1]));
    return 'OK';
  }

  private write(key: string, value: string, ttl?: number): void {
    this.store.set(key, value);
    if (ttl === undefined) this.expires.delete(key);
    else this.expires.set(key, this.now + ttl * 1000);
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.store.delete(key)) removed += 1;
      this.expires.delete(key);
    }
    return removed;
  }

  /** Model scripts as atomic transactions, including Redis expiry and fencing. */
  async eval(script: string, count: number, ...args: Array<string | number>): Promise<unknown> {
    if (this.failWrites) throw new Error('Redis unavailable after job claim');
    const [key, leaseKey] = args.slice(0, count).map(String);
    const argv = args.slice(count).map(String);
    const raw = this.read(key!);
    const lease = this.read(leaseKey!);

    if (script.includes('-- stream-job:release')) {
      if (this.read(key!) !== argv[0]) return 0;
      this.store.delete(key!);
      this.expires.delete(key!);
      return 1;
    }

    if (script.includes('-- stream-job:finish')) {
      if (lease !== argv[0]) return 0;
      const job = raw ? JSON.parse(raw) : null;
      if (!job || job.secret !== argv[1]) return 0;
      this.write(key!, argv[2]!, Number(argv[3]));
      this.store.delete(leaseKey!);
      this.expires.delete(leaseKey!);
      return 1;
    }

    if (script.includes('-- stream-job:ensure')) {
      let job: Record<string, unknown> | null;
      try { job = raw ? JSON.parse(raw) : null; } catch { job = null; }
      if (argv[7] && (!job || job.secret !== argv[7])) return ['', ''];
      const pending = JSON.parse(argv[0]!);
      if (!job) {
        job = pending;
        this.store.delete(leaseKey!);
        this.expires.delete(leaseKey!);
      }
      const backfill = !job!.secret;
      if (backfill) job!.secret = pending.secret;
      let owner = '';
      const retryAllowed = !argv[6] || !job!.failed || typeof job!.extracted_time !== 'number' ||
        job!.extracted_time <= Number(argv[6]) || job!.extracted_time > Number(argv[8]);
      if (retryAllowed && (!job!.extracted_url || job!.validation_version !== Number(argv[5])) && !this.read(leaseKey!)) {
        owner = argv[1]!;
        this.write(leaseKey!, owner, Number(argv[2]));
        job = { ...pending, secret: job!.secret };
        this.write(key!, JSON.stringify(job), Number(argv[3]));
      } else if (!raw || backfill) {
        this.write(key!, JSON.stringify(job), Number(job!.proxy_url ? argv[4] : argv[3]));
      }
      return [JSON.stringify(job), owner];
    }

    if (script.includes('-- stream-job:refresh')) {
      if (!raw) return ['', ''];
      const job = JSON.parse(raw);
      if (job.secret && job.secret !== argv[1]) return ['', ''];
      const rejectedUrl = JSON.parse(argv[2]!);
      if (job.extracted_url && job.extracted_url !== rejectedUrl) return [raw, ''];
      if (lease) return [raw, ''];
      const owner = argv[0]!;
      this.write(leaseKey!, owner, Number(argv[3]));
      const pending = {
        ...job, extracted_url: null, extracted_time: null, proxy_url: null,
        failed: false, secret: job.secret ?? argv[1],
      };
      this.write(key!, JSON.stringify(pending), Number(argv[4]));
      return [JSON.stringify(pending), owner];
    }

    throw new Error('Unexpected stream-job Redis script');
  }
}
