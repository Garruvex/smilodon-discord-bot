const typingRefreshIntervalMs = 8_000;

interface ActiveTyping {
  requestCount: number;
  timer: NodeJS.Timeout;
}

export class ChannelTypingManager {
  private readonly activeChannels = new Map<string, ActiveTyping>();

  public start(channelId: string, sendTyping: () => Promise<unknown>): () => void {
    const existing = this.activeChannels.get(channelId);
    if (existing) {
      existing.requestCount++;
      return this.createStop(channelId);
    }

    const refresh = (): void => {
      void sendTyping().catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, typingRefreshIntervalMs);
    timer.unref();
    this.activeChannels.set(channelId, { requestCount: 1, timer });
    return this.createStop(channelId);
  }

  private createStop(channelId: string): () => void {
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      const active = this.activeChannels.get(channelId);
      if (!active) return;
      active.requestCount--;
      if (active.requestCount > 0) return;
      clearInterval(active.timer);
      this.activeChannels.delete(channelId);
    };
  }
}
