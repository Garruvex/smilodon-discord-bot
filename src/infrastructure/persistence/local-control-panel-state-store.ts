import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import type {
  ControlPanelRuntimeState,
  ControlPanelStateStore,
} from "../../application/control-panel/control-panel-state-store.js";

const stateFileSchema = z.record(
  z.string(),
  z.object({
    guildId: z.string(),
    channelId: z.string(),
    messageId: z.string(),
  }),
);

export class LocalControlPanelStateStore implements ControlPanelStateStore {
  private readonly stateFile: string;
  private readonly states: Map<string, ControlPanelRuntimeState>;

  public constructor(runtimeDataDirectory: string) {
    this.stateFile = resolve(runtimeDataDirectory, "control-panels.json");
    mkdirSync(dirname(this.stateFile), { recursive: true });
    this.states = this.load();
  }

  public initialize(): Promise<void> {
    return Promise.resolve();
  }

  public find(guildId: string): ControlPanelRuntimeState | null {
    return this.states.get(guildId) ?? null;
  }

  public save(state: ControlPanelRuntimeState): Promise<void> {
    this.states.set(state.guildId, state);
    this.flush();
    return Promise.resolve();
  }

  public delete(guildId: string): Promise<void> {
    if (this.states.delete(guildId)) {
      this.flush();
    }
    return Promise.resolve();
  }

  private load(): Map<string, ControlPanelRuntimeState> {
    if (!existsSync(this.stateFile)) {
      return new Map();
    }

    let document: unknown;
    try {
      document = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch (error) {
      throw new Error(`Unable to read control-panel state "${this.stateFile}".`, {
        cause: error,
      });
    }

    const result = stateFileSchema.safeParse(document);
    if (!result.success) {
      throw new Error(
        `Invalid control-panel state "${this.stateFile}": ${result.error.message}`,
      );
    }

    return new Map(Object.entries(result.data));
  }

  private flush(): void {
    const document = Object.fromEntries(this.states);
    const temporaryFile = `${this.stateFile}.tmp`;
    writeFileSync(temporaryFile, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    renameSync(temporaryFile, this.stateFile);
  }
}
