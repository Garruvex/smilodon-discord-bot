import type { MemoryRepository } from "./memory.js";

// Honours a deleted Discord message: memories and relations learned from it in conversation are
// deleted, unless the guild turned that off. What a daily summary or history scan built is kept.
// Recall never re-checks a cited message, so this event is how a deletion reaches memory.
export class DeletedMessageMemory {
  public constructor(
    private readonly repository: Pick<MemoryRepository, "forgetCitingMessages">,
    private readonly honoured: (guildId: string) => boolean,
  ) {}

  public async handle(guildId: string, channelId: string, messageIds: readonly string[]): Promise<number> {
    if (!messageIds.length || !this.repository.forgetCitingMessages || !this.honoured(guildId)) return 0;
    return this.repository.forgetCitingMessages({ guildId, channelId, messageIds });
  }
}
