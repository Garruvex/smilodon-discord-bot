// Spotting a raid: many accounts joining within moments. Pure and in memory.

export interface TrackedJoin {
  userId: string;
  at: number;
  // When the account itself was made, which says how new it is.
  accountCreatedAt: number;
}

export interface JoinVerdict {
  raid: boolean;
  // True once, on the join that first crosses the threshold: the moment to
  // alert staff. Later joins in the same raid are raid but not new.
  started: boolean;
  // Who to deal with: everyone in the burst when it starts, and each later
  // joiner one at a time while it lasts.
  affected: readonly TrackedJoin[];
}

const calm: JoinVerdict = { raid: false, started: false, affected: [] };

export class JoinTracker {
  private readonly recent = new Map<string, TrackedJoin[]>();
  private readonly activeUntil = new Map<string, number>();

  public record(guildId: string, join: TrackedJoin, windowMs: number, threshold: number): JoinVerdict {
    const joins = [...(this.recent.get(guildId) ?? []).filter((entry) => entry.at >= join.at - windowMs), join];
    this.recent.set(guildId, joins);

    if ((this.activeUntil.get(guildId) ?? 0) > join.at) {
      // Still in the raid: the window keeps sliding while joins keep coming.
      this.activeUntil.set(guildId, join.at + windowMs);
      return { raid: true, started: false, affected: [join] };
    }
    if (joins.length >= threshold) {
      this.activeUntil.set(guildId, join.at + windowMs);
      return { raid: true, started: true, affected: joins };
    }
    return calm;
  }
}

export function accountAgeDays(join: TrackedJoin): number {
  return Math.max(0, (join.at - join.accountCreatedAt) / 86_400_000);
}
