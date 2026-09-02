export interface PanelRefreshOptions {
  forceIdleImage?: boolean;
  /** Skip the debounce window and render on the next tick. */
  immediate?: boolean;
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

const defaultDebounceMs = 200;
const defaultMaxWaitMs = 900;

/**
 * Per-guild trailing debounce: bursts of refresh requests within the
 * debounce window collapse into a single edit, capped by a max wait so
 * sustained activity can't starve a render indefinitely. At most one edit
 * is ever in flight per guild; a request that arrives while one is running
 * is deferred to exactly one trailing edit once it finishes.
 */
class GuildRefreshScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private batchStartedAt: number | null = null;
  private forceIdleImage = false;
  private immediate = false;
  private waiters: Waiter[] = [];

  private running = false;
  private rerunRequested = false;
  private rerunForceIdleImage = false;
  private rerunImmediate = false;
  private rerunWaiters: Waiter[] = [];

  private stopped = false;

  public constructor(
    private readonly guildId: string,
    private readonly refresh: (guildId: string, options: PanelRefreshOptions) => Promise<void>,
    private readonly debounceMs: number,
    private readonly maxWaitMs: number,
  ) {}

  public request(options: PanelRefreshOptions): Promise<void> {
    if (this.stopped) return Promise.resolve();

    if (this.running) {
      this.rerunRequested = true;
      this.rerunForceIdleImage ||= options.forceIdleImage === true;
      this.rerunImmediate ||= options.immediate === true;
      return new Promise((resolve, reject) => {
        this.rerunWaiters.push({ resolve, reject });
      });
    }

    this.forceIdleImage ||= options.forceIdleImage === true;
    this.immediate ||= options.immediate === true;
    this.batchStartedAt ??= Date.now();
    this.scheduleTimer();

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    const error = new Error("Panel refresh coordinator stopped");
    for (const waiter of this.waiters) waiter.reject(error);
    for (const waiter of this.rerunWaiters) waiter.reject(error);
    this.waiters = [];
    this.rerunWaiters = [];
  }

  private scheduleTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.immediate) {
      this.timer = setTimeout(() => void this.fire(), 0);
      this.timer.unref?.();
      return;
    }

    const elapsed = Date.now() - (this.batchStartedAt ?? Date.now());
    const wait = Math.min(this.debounceMs, Math.max(0, this.maxWaitMs - elapsed));
    this.timer = setTimeout(() => void this.fire(), wait);
    this.timer.unref?.();
  }

  private async fire(): Promise<void> {
    if (this.stopped) return;
    this.timer = null;

    const waiters = this.waiters;
    const options: PanelRefreshOptions = { forceIdleImage: this.forceIdleImage };
    this.waiters = [];
    this.forceIdleImage = false;
    this.immediate = false;
    this.batchStartedAt = null;
    this.running = true;

    try {
      await this.refresh(this.guildId, options);
      for (const waiter of waiters) waiter.resolve();
    } catch (error) {
      for (const waiter of waiters) waiter.reject(error);
    } finally {
      this.running = false;
      if (!this.stopped && this.rerunRequested) {
        this.rerunRequested = false;
        this.forceIdleImage = this.rerunForceIdleImage;
        this.immediate = this.rerunImmediate;
        this.rerunForceIdleImage = false;
        this.rerunImmediate = false;
        this.waiters = this.rerunWaiters;
        this.rerunWaiters = [];
        this.batchStartedAt = Date.now();
        this.scheduleTimer();
      }
    }
  }
}

export class PanelRefreshCoordinator {
  private readonly guilds = new Map<string, GuildRefreshScheduler>();
  private stopped = false;

  public constructor(
    private readonly refresh: (
      guildId: string,
      options: PanelRefreshOptions,
    ) => Promise<void>,
    private readonly debounceMs: number = defaultDebounceMs,
    private readonly maxWaitMs: number = defaultMaxWaitMs,
  ) {}

  public request(guildId: string, options: PanelRefreshOptions = {}): Promise<void> {
    if (this.stopped) return Promise.resolve();

    let scheduler = this.guilds.get(guildId);
    if (!scheduler) {
      scheduler = new GuildRefreshScheduler(guildId, this.refresh, this.debounceMs, this.maxWaitMs);
      this.guilds.set(guildId, scheduler);
    }
    return scheduler.request(options);
  }

  /**
   * Cancels one guild's pending/trailing work (e.g. the bot left that
   * guild). Unlike {@link stop}, the coordinator keeps working normally for
   * every other guild, and this guild resumes normally on its next request.
   */
  public stopGuild(guildId: string): void {
    this.guilds.get(guildId)?.stop();
    this.guilds.delete(guildId);
  }

  /** Full shutdown: cancels every guild and rejects all future requests. */
  public stop(): void {
    this.stopped = true;
    for (const scheduler of this.guilds.values()) scheduler.stop();
    this.guilds.clear();
  }
}
