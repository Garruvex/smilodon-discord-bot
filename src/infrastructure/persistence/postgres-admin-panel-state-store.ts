import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { AdminPanelState, AdminPanelStateStore } from "../../application/settings/admin-panel-state-store.js";
import * as schema from "../database/schema.js";

export class PostgresAdminPanelStateStore implements AdminPanelStateStore {
  private readonly states = new Map<string, AdminPanelState>();

  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  public async initialize(): Promise<void> {
    const rows = await this.database.select().from(schema.adminPanels);
    this.states.clear();
    for (const row of rows) {
      this.states.set(row.guildId, { guildId: row.guildId, channelId: row.channelId, messages: row.messages });
    }
  }

  public find(guildId: string): AdminPanelState | null {
    return this.states.get(guildId) ?? null;
  }

  public async save(state: AdminPanelState): Promise<void> {
    const messages = { ...state.messages };
    await this.database
      .insert(schema.adminPanels)
      .values({ guildId: state.guildId, channelId: state.channelId, messages })
      .onConflictDoUpdate({
        target: schema.adminPanels.guildId,
        set: { channelId: state.channelId, messages, updatedAt: new Date() },
      });
    this.states.set(state.guildId, state);
  }

  public async delete(guildId: string): Promise<void> {
    await this.database.delete(schema.adminPanels).where(eq(schema.adminPanels.guildId, guildId));
    this.states.delete(guildId);
  }
}
