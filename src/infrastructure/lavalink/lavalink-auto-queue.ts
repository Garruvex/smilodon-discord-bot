import type {
  Player,
  SearchResult,
  Track,
  UnresolvedSearchResult,
  UnresolvedTrack,
} from "lavalink-client";

export type AutoQueueOutcome =
  | { status: "queued"; trackIdentifier: string }
  | { status: "empty" }
  | { status: "failed"; error: unknown };

const recentTrackLimit = 50;

/**
 * Owns recommendation discovery for Lavalink players. Queue lifecycle and
 * connection-retention decisions intentionally remain in the player gateway.
 */
export class LavalinkAutoQueue {
  private readonly recentTracksByGuild = new Map<string, string[]>();

  public async enqueueNext(
    player: Player,
    sourceTrack: Track | UnresolvedTrack,
  ): Promise<AutoQueueOutcome> {
    this.remember(player.guildId, sourceTrack);
    const excludedIdentifiers = new Set([
      ...(this.recentTracksByGuild.get(player.guildId) ?? []),
      ...player.queue.previous.map((track) => this.identifier(track)),
      ...player.queue.tracks.map((track) => this.identifier(track)),
    ]);
    if (player.queue.current) {
      excludedIdentifiers.add(this.identifier(player.queue.current));
    }
    let lastError: unknown;
    let completedSearch = false;

    for (const query of this.buildQueries(sourceTrack)) {
      try {
        const result = await this.searchWithFallback(player, query);
        completedSearch = true;
        const recommendation = result.tracks.find(
          (track) => !excludedIdentifiers.has(this.identifier(track)),
        );
        if (!recommendation) continue;

        recommendation.userData = {
          ...recommendation.userData,
          requestedByUserId: "autoqueue",
        };
        await player.queue.add(recommendation);
        this.remember(player.guildId, recommendation);
        return {
          status: "queued",
          trackIdentifier: this.identifier(recommendation),
        };
      } catch (error) {
        lastError = error;
      }
    }

    return completedSearch
      ? { status: "empty" }
      : { status: "failed", error: lastError };
  }

  public clear(guildId: string): void {
    this.recentTracksByGuild.delete(guildId);
  }

  private async searchWithFallback(
    player: Player,
    query: string,
  ): Promise<SearchResult | UnresolvedSearchResult> {
    try {
      const primary = await player.search(
        { query, source: "spsearch" },
        { userId: "autoqueue" },
      );
      if (primary.tracks.length > 0) return primary;
    } catch {
      // Spotify search failed; fall through to YouTube below.
    }

    return player.search({ query, source: "ytsearch" }, { userId: "autoqueue" });
  }

  private buildQueries(sourceTrack: Track | UnresolvedTrack): string[] {
    const identifier = sourceTrack.info.identifier;
    const textQuery = `${sourceTrack.info.author ?? ""} ${sourceTrack.info.title}`.trim();
    return sourceTrack.info.sourceName === "youtube" && identifier
      ? [`https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}`, textQuery]
      : [textQuery];
  }

  private remember(guildId: string, track: Track | UnresolvedTrack): void {
    const identifier = this.identifier(track);
    const history = this.recentTracksByGuild.get(guildId) ?? [];
    const withoutDuplicate = history.filter((entry) => entry !== identifier);
    withoutDuplicate.push(identifier);
    if (withoutDuplicate.length > recentTrackLimit) {
      withoutDuplicate.splice(0, withoutDuplicate.length - recentTrackLimit);
    }
    this.recentTracksByGuild.set(guildId, withoutDuplicate);
  }

  private identifier(track: Track | UnresolvedTrack): string {
    if (track.info.identifier) return track.info.identifier;
    if (track.info.uri) return track.info.uri;
    // Fallback for sources with neither a stable identifier nor a URI.
    // Normalizing whitespace/case avoids near-duplicate formatting (extra
    // spaces, casing differences) from being treated as distinct tracks and
    // slipping past the recent-tracks exclusion list.
    const author = (track.info.author ?? "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
    const title = track.info.title.trim().toLocaleLowerCase().replace(/\s+/g, " ");
    return `${author}:${title}`;
  }
}
