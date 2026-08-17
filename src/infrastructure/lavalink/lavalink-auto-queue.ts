import type { Player, Track, UnresolvedTrack } from "lavalink-client";

export type AutoQueueOutcome =
  | { status: "queued"; trackIdentifier: string }
  | { status: "empty" }
  | { status: "failed"; error: unknown };

/**
 * Owns recommendation discovery for Lavalink players. Queue lifecycle and
 * connection-retention decisions intentionally remain in the player gateway.
 */
export class LavalinkAutoQueue {
  public async enqueueNext(
    player: Player,
    sourceTrack: Track | UnresolvedTrack,
  ): Promise<AutoQueueOutcome> {
    const playedIdentifiers = new Set([
      sourceTrack.info.identifier,
      ...player.queue.previous.map((track) => track.info.identifier),
    ]);
    let lastError: unknown;
    let completedSearch = false;

    for (const query of this.buildQueries(sourceTrack)) {
      try {
        const result = await player.search({ query }, { userId: "autoqueue" });
        completedSearch = true;
        const recommendation = result.tracks.find(
          (track) => !playedIdentifiers.has(track.info.identifier),
        );
        if (!recommendation) continue;

        recommendation.userData = {
          ...recommendation.userData,
          requestedByUserId: "autoqueue",
        };
        await player.queue.add(recommendation);
        return {
          status: "queued",
          trackIdentifier:
            recommendation.info.identifier ??
            recommendation.info.uri ??
            recommendation.info.title,
        };
      } catch (error) {
        lastError = error;
      }
    }

    return completedSearch
      ? { status: "empty" }
      : { status: "failed", error: lastError };
  }

  private buildQueries(sourceTrack: Track | UnresolvedTrack): string[] {
    const identifier = sourceTrack.info.identifier;
    const textQuery = `${sourceTrack.info.author ?? ""} ${sourceTrack.info.title}`.trim();
    return sourceTrack.info.sourceName === "youtube" && identifier
      ? [`https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}`, textQuery]
      : [textQuery];
  }
}
