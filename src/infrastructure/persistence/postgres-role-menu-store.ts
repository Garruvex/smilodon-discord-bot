import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { RoleMenu, RoleMenuOption, RoleMenuStore } from "../../application/roles/role-menu-store.js";
import * as schema from "../database/schema.js";

function toRoleMenu(row: typeof schema.roleMenus.$inferSelect): RoleMenu {
  return {
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    options: row.options as readonly RoleMenuOption[],
  };
}

export class PostgresRoleMenuStore implements RoleMenuStore {
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  public initialize(): Promise<void> {
    return Promise.resolve();
  }

  public async create(menu: RoleMenu): Promise<void> {
    await this.database.insert(schema.roleMenus).values({
      messageId: menu.messageId,
      guildId: menu.guildId,
      channelId: menu.channelId,
      options: menu.options,
    });
  }

  public async find(messageId: string): Promise<RoleMenu | null> {
    const rows = await this.database.select().from(schema.roleMenus)
      .where(eq(schema.roleMenus.messageId, messageId)).limit(1);
    const row = rows[0];
    return row ? toRoleMenu(row) : null;
  }

  public async listForGuild(guildId: string): Promise<readonly RoleMenu[]> {
    const rows = await this.database.select().from(schema.roleMenus)
      .where(eq(schema.roleMenus.guildId, guildId));
    return rows.map(toRoleMenu);
  }

  public async remove(messageId: string): Promise<boolean> {
    const result = await this.database.delete(schema.roleMenus)
      .where(eq(schema.roleMenus.messageId, messageId))
      .returning({ messageId: schema.roleMenus.messageId });
    return result.length > 0;
  }
}
