const defaultCooldownMs = 3_000;
const retentionMs = 60 * 60 * 1_000;

export class PlaybackRateLimiter {
  private readonly lastRequest = new Map<string, number>();

  public constructor(private readonly cooldownMs = defaultCooldownMs) {}

  public check(guildId: string, userId: string): number | null {
    this.pruneStaleEntries();
    const key = `${guildId}:${userId}`;
    const retryAt = (this.lastRequest.get(key) ?? 0) + this.cooldownMs;
    const remainingMs = retryAt - Date.now();
    if (remainingMs > 0) {
      return Math.max(1, Math.ceil(remainingMs / 1_000));
    }
    return null;
  }

  public record(guildId: string, userId: string): void {
    this.lastRequest.set(`${guildId}:${userId}`, Date.now());
  }

  private pruneStaleEntries(): void {
    const cutoff = Date.now() - retentionMs;
    for (const [key, timestamp] of this.lastRequest) {
      if (timestamp < cutoff) {
        this.lastRequest.delete(key);
      }
    }
  }
}
