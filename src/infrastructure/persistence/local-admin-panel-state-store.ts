import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import type { AdminPanelState, AdminPanelStateStore } from "../../application/settings/admin-panel-state-store.js";

const stateFileSchema = z.record(z.string(), z.object({
  guildId: z.string(),
  channelId: z.string(),
  messages: z.record(z.string(), z.string()),
}));

export class LocalAdminPanelStateStore implements AdminPanelStateStore {
  private readonly stateFile: string;
  private readonly states: Map<string, AdminPanelState>;

  public constructor(runtimeDataDirectory: string) {
    this.stateFile = resolve(runtimeDataDirectory, "admin-panels.json");
    mkdirSync(dirname(this.stateFile), { recursive: true });
    this.states = this.load();
  }

  public initialize(): Promise<void> {
    return Promise.resolve();
  }

  public find(guildId: string): AdminPanelState | null {
    return this.states.get(guildId) ?? null;
  }

  public save(state: AdminPanelState): Promise<void> {
    this.states.set(state.guildId, state);
    this.flush();
    return Promise.resolve();
  }

  public delete(guildId: string): Promise<void> {
    if (this.states.delete(guildId)) this.flush();
    return Promise.resolve();
  }

  private load(): Map<string, AdminPanelState> {
    if (!existsSync(this.stateFile)) return new Map();
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch (error) {
      throw new Error(`Unable to read admin-panel state "${this.stateFile}".`, { cause: error });
    }
    const result = stateFileSchema.safeParse(document);
    if (!result.success) throw new Error(`Invalid admin-panel state "${this.stateFile}": ${result.error.message}`);
    return new Map(Object.entries(result.data));
  }

  private flush(): void {
    const temporaryFile = `${this.stateFile}.tmp`;
    writeFileSync(temporaryFile, `${JSON.stringify(Object.fromEntries(this.states), null, 2)}\n`, "utf8");
    renameSync(temporaryFile, this.stateFile);
  }
}
