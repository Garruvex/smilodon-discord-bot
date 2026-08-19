import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../database/schema.js";

// Resolves the guild_members hub row for a (guildId, userId) pair, creating
// it on first write. member_id is additive on the tables that reference it
// (see schema.ts) — it exists purely so ON DELETE CASCADE has something to
// cascade from, and as a join point for future per-member features. Every
// existing read-path query keeps filtering by guildId/userId directly.
export class GuildMemberRegistry {
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  public async resolveMemberId(guildId: string, userId: string): Promise<string> {
    const rows = await this.database.insert(schema.guildMembers)
      .values({ guildId, userId })
      .onConflictDoUpdate({
        target: [schema.guildMembers.guildId, schema.guildMembers.userId],
        set: { updatedAt: new Date() },
      })
      .returning({ id: schema.guildMembers.id });
    return rows[0]!.id;
  }

  public async deleteMember(guildId: string, userId: string): Promise<void> {
    await this.database.delete(schema.guildMembers).where(and(
      eq(schema.guildMembers.guildId, guildId),
      eq(schema.guildMembers.userId, userId),
    ));
  }
}
