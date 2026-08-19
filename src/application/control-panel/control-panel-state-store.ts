export interface ControlPanelRuntimeState {
  guildId: string;
  channelId: string;
  messageId: string;
}

export interface ControlPanelStateStore {
  initialize(): Promise<void>;
  find(guildId: string): ControlPanelRuntimeState | null;
  save(state: ControlPanelRuntimeState): Promise<void>;
  delete(guildId: string): Promise<void>;
}
