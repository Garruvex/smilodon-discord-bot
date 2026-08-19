import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type {
  ControlPanelRuntimeState,
  ControlPanelStateStore,
} from "../../application/control-panel/control-panel-state-store.js";
import * as schema from "../database/schema.js";

export class PostgresControlPanelStateStore implements ControlPanelStateStore {
  private readonly states = new Map<string, ControlPanelRuntimeState>();

  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  public async initialize(): Promise<void> {
    const rows = await this.database.select().from(schema.controlPanels);
    this.states.clear();
    for (const row of rows) {
      this.states.set(row.guildId, {
        guildId: row.guildId,
        channelId: row.channelId,
        messageId: row.messageId,
      });
    }
  }

  public find(guildId: string): ControlPanelRuntimeState | null {
    return this.states.get(guildId) ?? null;
  }

  public async save(state: ControlPanelRuntimeState): Promise<void> {
    await this.database
      .insert(schema.controlPanels)
      .values(state)
      .onConflictDoUpdate({
        target: schema.controlPanels.guildId,
        set: {
          channelId: state.channelId,
          messageId: state.messageId,
          updatedAt: new Date(),
        },
      });
    this.states.set(state.guildId, state);
  }

  public async delete(guildId: string): Promise<void> {
    await this.database
      .delete(schema.controlPanels)
      .where(eq(schema.controlPanels.guildId, guildId));
    this.states.delete(guildId);
  }
}
