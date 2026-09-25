// Where a guild's admin panel lives: its channel and the id of each panel
// message, keyed like the panel renders them ("header", "music#0",
// "chat.abilities#1"). Stored so the panel is edited in place and a deleted
// message is recognized exactly, whatever else is in the channel.
export interface AdminPanelState {
  guildId: string;
  channelId: string;
  messages: Readonly<Record<string, string>>;
}

export interface AdminPanelStateStore {
  initialize(): Promise<void>;
  find(guildId: string): AdminPanelState | null;
  save(state: AdminPanelState): Promise<void>;
  delete(guildId: string): Promise<void>;
}
