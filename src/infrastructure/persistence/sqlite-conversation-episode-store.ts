import { and, eq, lt } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { KeyedSerialQueue } from "../../application/concurrency/keyed-serial-queue.js";
import { boundEpisodeEvents, episodeRetentionMs, excludeEpisodeInteraction, forgetEpisodeUser, type ConversationEpisodeStore } from "../../application/chat/conversation-episode-store.js";
import type { ChannelHistoryMessage } from "../../application/chat/chat-provider.js";
import * as schema from "../database/sqlite-schema.js";

export class SqliteConversationEpisodeStore implements ConversationEpisodeStore {
  private readonly queue = new KeyedSerialQueue();
  public constructor(private readonly database: BetterSQLite3Database<typeof schema>) {}
  public load(guildId: string, channelId: string, now: number): Promise<readonly ChannelHistoryMessage[]> {
    return this.queue.run(`${guildId}:${channelId}`, () => Promise.resolve(boundEpisodeEvents(this.read(guildId, channelId), now)));
  }
  public observe(guildId: string, channelId: string, event: ChannelHistoryMessage, now: number): Promise<void> {
    return this.queue.run(`${guildId}:${channelId}`, () => {
      this.database.transaction(() => this.write(guildId, channelId, boundEpisodeEvents([...this.read(guildId, channelId), event], now), now));
      return Promise.resolve();
    });
  }
  public exclude(guildId: string, channelId: string, sourceMessageId: string): Promise<void> {
    return this.queue.run(`${guildId}:${channelId}`, () => {
      this.database.transaction(() => this.write(guildId, channelId, excludeEpisodeInteraction(this.read(guildId, channelId), sourceMessageId), Date.now()));
      return Promise.resolve();
    });
  }
  public deleteExpired(now: number): Promise<void> {
    this.database.delete(schema.conversationEpisodes).where(lt(schema.conversationEpisodes.updatedAt, new Date(now - episodeRetentionMs))).run();
    return Promise.resolve();
  }
  public async forgetUser(guildId: string, userId: string): Promise<void> {
    const rows = this.database.select({ channelId: schema.conversationEpisodes.channelId }).from(schema.conversationEpisodes)
      .where(eq(schema.conversationEpisodes.guildId, guildId)).all();
    for (const row of rows) await this.queue.run(`${guildId}:${row.channelId}`, () => {
      this.write(guildId, row.channelId, forgetEpisodeUser(this.read(guildId, row.channelId), userId), Date.now());
      return Promise.resolve();
    });
  }
  private read(guildId: string, channelId: string): ChannelHistoryMessage[] {
    return this.database.select().from(schema.conversationEpisodes).where(and(eq(schema.conversationEpisodes.guildId, guildId),
      eq(schema.conversationEpisodes.channelId, channelId))).get()?.events ?? [];
  }
  private write(guildId: string, channelId: string, events: ChannelHistoryMessage[], now: number): void {
    this.database.insert(schema.conversationEpisodes).values({ guildId, channelId, events, updatedAt: new Date(now) })
      .onConflictDoUpdate({ target: [schema.conversationEpisodes.guildId, schema.conversationEpisodes.channelId], set: { events, updatedAt: new Date(now) } }).run();
  }
}
