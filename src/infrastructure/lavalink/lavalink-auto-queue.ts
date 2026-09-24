import type {
  Player,
  SearchResult,
  Track,
  UnresolvedSearchResult,
  UnresolvedTrack,
} from "lavalink-client";

import { cleanArtistName } from "../../domain/music/artist-name.js";

export type AutoQueueOutcome =
  | { status: "queued"; trackIdentifier: string }
  | { status: "empty" }
  | { status: "failed"; error: unknown };

export type AutoQueueCandidatesOutcome =
  | { status: "found"; tracks: (Track | UnresolvedTrack)[] }
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
    const outcome = await this.findCandidates(player, sourceTrack, 1);
    if (outcome.status !== "found") return outcome;
    return this.enqueue(player, outcome.tracks[0]!);
  }

  // Ranked, unplayed recommendations for what should follow `sourceTrack`.
  // The first entry is always what enqueueNext would have picked, so a vote
  // nobody participates in behaves exactly like plain autoqueue.
  // `alsoExclude` lets a reroll skip the options it's replacing.
  public async findCandidates(
    player: Player,
    sourceTrack: Track | UnresolvedTrack,
    limit: number,
    alsoExclude: Iterable<string> = [],
  ): Promise<AutoQueueCandidatesOutcome> {
    this.remember(player.guildId, sourceTrack);
    return this.collectCandidates(player, this.buildQueries(sourceTrack), limit, alsoExclude, () => true);
  }

  // Other unplayed songs by `sourceTrack`'s artist, for the vote's "More
  // from Artist" reroll. Results whose artist doesn't match are dropped, since
  // a plain-text artist search also turns up covers, reactions and
  // soundalikes.
  public async findArtistCandidates(
    player: Player,
    sourceTrack: Track | UnresolvedTrack,
    limit: number,
    alsoExclude: Iterable<string> = [],
  ): Promise<AutoQueueCandidatesOutcome> {
    const artist = cleanArtistName(sourceTrack.info.author ?? "");
    if (!artist) return { status: "empty" };
    const wanted = artist.toLocaleLowerCase();
    return this.collectCandidates(
      player,
      [artist],
      limit,
      alsoExclude,
      (track) => cleanArtistName(track.info.author ?? "").toLocaleLowerCase().includes(wanted),
    );
  }

  private async collectCandidates(
    player: Player,
    queries: readonly string[],
    limit: number,
    alsoExclude: Iterable<string>,
    accept: (track: Track | UnresolvedTrack) => boolean,
  ): Promise<AutoQueueCandidatesOutcome> {
    const excludedIdentifiers = new Set([
      ...(this.recentTracksByGuild.get(player.guildId) ?? []),
      ...player.queue.previous.map((track) => this.identifier(track)),
      ...player.queue.tracks.map((track) => this.identifier(track)),
      ...alsoExclude,
    ]);
    if (player.queue.current) {
      excludedIdentifiers.add(this.identifier(player.queue.current));
    }
    const candidates: (Track | UnresolvedTrack)[] = [];
    let lastError: unknown;
    let completedSearch = false;

    for (const query of queries) {
      if (candidates.length >= limit) break;
      try {
        const result = await this.searchWithFallback(player, query);
        completedSearch = true;
        for (const track of result.tracks) {
          if (candidates.length >= limit) break;
          const identifier = this.identifier(track);
          if (excludedIdentifiers.has(identifier) || !accept(track)) continue;
          excludedIdentifiers.add(identifier);
          candidates.push(track);
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (candidates.length > 0) return { status: "found", tracks: candidates };
    return completedSearch
      ? { status: "empty" }
      : { status: "failed", error: lastError };
  }

  public async enqueue(
    player: Player,
    recommendation: Track | UnresolvedTrack,
  ): Promise<AutoQueueOutcome> {
    try {
      recommendation.userData = {
        ...recommendation.userData,
        requestedByUserId: "autoqueue",
      };
      await player.queue.add(recommendation);
      this.remember(player.guildId, recommendation);
      return { status: "queued", trackIdentifier: this.identifier(recommendation) };
    } catch (error) {
      return { status: "failed", error };
    }
  }

  public clear(guildId: string): void {
    this.recentTracksByGuild.delete(guildId);
  }

  public identifier(track: Track | UnresolvedTrack): string {
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
}
