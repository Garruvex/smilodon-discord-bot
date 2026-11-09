import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { KeyedSerialQueue } from "../../application/concurrency/keyed-serial-queue.js";
import { boundEpisodeEvents, episodeRetentionMs, excludeEpisodeInteraction, forgetEpisodeUser, type ConversationEpisodeStore } from "../../application/chat/conversation-episode-store.js";
import type { ChannelHistoryMessage } from "../../application/chat/chat-provider.js";
import * as schema from "../database/schema.js";

export class PostgresConversationEpisodeStore implements ConversationEpisodeStore {
  private readonly queue = new KeyedSerialQueue();
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}
  public load(guildId: string, channelId: string, now: number): Promise<readonly ChannelHistoryMessage[]> {
    return this.queue.run(`${guildId}:${channelId}`, async () => {
      const [row] = await this.database.select().from(schema.conversationEpisodes).where(and(eq(schema.conversationEpisodes.guildId, guildId),
        eq(schema.conversationEpisodes.channelId, channelId))).limit(1);
      return boundEpisodeEvents(row?.events ?? [], now, row?.retentionMs ?? episodeRetentionMs);
    });
  }
  public observe(guildId: string, channelId: string, event: ChannelHistoryMessage, now: number, retentionMs = episodeRetentionMs): Promise<void> {
    return this.mutate(guildId, channelId, (events) => boundEpisodeEvents([...events, event], now, retentionMs), now, retentionMs);
  }
  public exclude(guildId: string, channelId: string, sourceMessageId: string): Promise<void> {
    return this.mutate(guildId, channelId, (events) => excludeEpisodeInteraction(events, sourceMessageId), Date.now());
  }
  public async deleteExpired(now: number): Promise<void> {
    await this.database.delete(schema.conversationEpisodes).where(sql`${schema.conversationEpisodes.updatedAt} < ${new Date(now).toISOString()}::timestamptz - ${schema.conversationEpisodes.retentionMs} * interval '1 millisecond'`);
  }
  public async forgetUser(guildId: string, userId: string): Promise<void> {
    const rows = await this.database.select({ channelId: schema.conversationEpisodes.channelId }).from(schema.conversationEpisodes)
      .where(eq(schema.conversationEpisodes.guildId, guildId));
    for (const row of rows) await this.mutate(guildId, row.channelId, (events) => forgetEpisodeUser(events, userId), Date.now());
  }
  private mutate(guildId: string, channelId: string, transform: (events: ChannelHistoryMessage[]) => ChannelHistoryMessage[], now: number, retentionMs?: number): Promise<void> {
    return this.queue.run(`${guildId}:${channelId}`, () => this.database.transaction(async (transaction) => {
      await transaction.insert(schema.conversationEpisodes).values({ guildId, channelId, events: [], updatedAt: new Date(now) }).onConflictDoNothing();
      const [row] = await transaction.select().from(schema.conversationEpisodes).where(and(eq(schema.conversationEpisodes.guildId, guildId),
        eq(schema.conversationEpisodes.channelId, channelId))).limit(1).for("update");
      await transaction.update(schema.conversationEpisodes).set({ events: transform(row?.events ?? []), retentionMs: retentionMs ?? row?.retentionMs ?? episodeRetentionMs, updatedAt: new Date(now) }).where(and(
        eq(schema.conversationEpisodes.guildId, guildId), eq(schema.conversationEpisodes.channelId, channelId)));
    }));
  }
}
