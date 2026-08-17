export interface PanelRefreshOptions {
  forceIdleImage?: boolean;
}

interface PendingRefresh {
  running: boolean;
  requested: boolean;
  forceIdleImage: boolean;
  waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>;
}

/**
 * Serializes panel edits per guild and folds bursts into one latest-state edit.
 * Different guilds remain independent.
 */
export class PanelRefreshCoordinator {
  private readonly pendingByGuild = new Map<string, PendingRefresh>();

  public constructor(
    private readonly refresh: (
      guildId: string,
      options: PanelRefreshOptions,
    ) => Promise<void>,
  ) {}

  public request(guildId: string, options: PanelRefreshOptions = {}): Promise<void> {
    const pending = this.pendingByGuild.get(guildId) ?? {
      running: false,
      requested: false,
      forceIdleImage: false,
      waiters: [],
    };
    pending.requested = true;
    pending.forceIdleImage ||= options.forceIdleImage === true;
    this.pendingByGuild.set(guildId, pending);

    const completion = new Promise<void>((resolve, reject) => {
      pending.waiters.push({ resolve, reject });
    });
    if (!pending.running) void this.drain(guildId, pending);
    return completion;
  }

  private async drain(guildId: string, pending: PendingRefresh): Promise<void> {
    pending.running = true;
    try {
      while (pending.requested) {
        const options = { forceIdleImage: pending.forceIdleImage };
        pending.requested = false;
        pending.forceIdleImage = false;
        await this.refresh(guildId, options);
      }
      for (const waiter of pending.waiters) waiter.resolve();
    } catch (error) {
      for (const waiter of pending.waiters) waiter.reject(error);
    } finally {
      this.pendingByGuild.delete(guildId);
    }
  }
}
