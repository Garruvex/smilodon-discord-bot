import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { MemberDataPurger } from "../../application/members/member-data-purger.js";
import * as schema from "../database/schema.js";

// Deleting the guild_members hub row cascades away every table with a
// memberId FK (chat_sessions, dm_notes_preferences, chat_memories,
// user_customizations, birthdays — see schema.ts). The unified `memories`
// table and `reminders` have no such FK (see their schema.ts comments), so
// they're deleted explicitly here. All three deletes run in one transaction
// so a mid-purge failure can't leave any of this behind.
export class PostgresMemberDataPurger implements MemberDataPurger {
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  public async purge(guildId: string, userId: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.delete(schema.memories).where(and(
        eq(schema.memories.guildId, guildId),
        eq(schema.memories.ownerUserId, userId),
      ));
      await tx.delete(schema.reminders).where(and(
        eq(schema.reminders.guildId, guildId),
        eq(schema.reminders.userId, userId),
      ));
      await tx.delete(schema.guildMembers).where(and(
        eq(schema.guildMembers.guildId, guildId),
        eq(schema.guildMembers.userId, userId),
      ));
    });
  }
}
