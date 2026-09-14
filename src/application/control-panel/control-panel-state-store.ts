export interface ControlPanelRuntimeState {
  guildId: string;
  channelId: string;
  nowPlayingMessageId: string | null;
  lyricsMessageId: string | null;
  queueMessageId: string | null;
}

export interface ControlPanelStateStore {
  initialize(): Promise<void>;
  find(guildId: string): ControlPanelRuntimeState | null;
  save(state: ControlPanelRuntimeState): Promise<void>;
  delete(guildId: string): Promise<void>;
}
