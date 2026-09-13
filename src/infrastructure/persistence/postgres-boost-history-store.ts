import { and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { BoostEvent, BoostEventType, BoostHistoryStore } from "../../application/members/boost-history-store.js";
import * as schema from "../database/schema.js";
import type { GuildMemberRegistry } from "./guild-member-registry.js";

export class PostgresBoostHistoryStore implements BoostHistoryStore {
  public constructor(
    private readonly database: PostgresJsDatabase<typeof schema>,
    private readonly memberRegistry: GuildMemberRegistry,
  ) {}

  public initialize(): Promise<void> {
    return Promise.resolve();
  }

  public async recordEvent(
    guildId: string,
    userId: string,
    eventType: BoostEventType,
    occurredAt: Date,
  ): Promise<void> {
    const memberId = await this.memberRegistry.resolveMemberId(guildId, userId);
    await this.database.insert(schema.memberBoostEvents).values({
      guildId, userId, memberId, eventType, occurredAt,
    });
  }

  public async listEvents(guildId: string, userId: string): Promise<readonly BoostEvent[]> {
    const rows = await this.database.select({
      eventType: schema.memberBoostEvents.eventType,
      occurredAt: schema.memberBoostEvents.occurredAt,
    }).from(schema.memberBoostEvents).where(and(
      eq(schema.memberBoostEvents.guildId, guildId),
      eq(schema.memberBoostEvents.userId, userId),
    )).orderBy(asc(schema.memberBoostEvents.occurredAt));
    return rows.map((row) => ({ eventType: row.eventType as BoostEventType, occurredAt: row.occurredAt }));
  }

  public async removeForUser(guildId: string, userId: string): Promise<void> {
    await this.database.delete(schema.memberBoostEvents).where(and(
      eq(schema.memberBoostEvents.guildId, guildId),
      eq(schema.memberBoostEvents.userId, userId),
    ));
  }
}
