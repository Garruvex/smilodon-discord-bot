import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { UserCustomizationStore } from "../../application/chat/user-customization-store.js";
import * as schema from "../database/schema.js";
import type { GuildMemberRegistry } from "./guild-member-registry.js";

export class PostgresUserCustomizationStore implements UserCustomizationStore {
  public constructor(
    private readonly database: PostgresJsDatabase<typeof schema>,
    private readonly memberRegistry: GuildMemberRegistry,
  ) {}

  public initialize(): Promise<void> {
    return Promise.resolve();
  }

  public async load(guildId: string, userId: string): Promise<string | null> {
    const rows = await this.database.select({ customization: schema.userCustomizations.customization })
      .from(schema.userCustomizations)
      .where(and(eq(schema.userCustomizations.guildId, guildId), eq(schema.userCustomizations.userId, userId)))
      .limit(1);
    return rows[0]?.customization ?? null;
  }

  public async save(guildId: string, userId: string, markdown: string): Promise<void> {
    const memberId = await this.memberRegistry.resolveMemberId(guildId, userId);
    await this.database.insert(schema.userCustomizations).values({
      guildId, userId, memberId, customization: markdown, updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [schema.userCustomizations.guildId, schema.userCustomizations.userId],
      set: { customization: markdown, updatedAt: new Date(), memberId },
    });
  }

  public async clear(guildId: string, userId: string): Promise<void> {
    await this.database.delete(schema.userCustomizations).where(
      and(eq(schema.userCustomizations.guildId, guildId), eq(schema.userCustomizations.userId, userId)),
    );
  }
}
