export interface UserCustomizationStore {
  initialize(): Promise<void>;
  // Raw markdown as saved by the user, or null if they haven't set anything.
  load(guildId: string, userId: string): Promise<string | null>;
  save(guildId: string, userId: string, markdown: string): Promise<void>;
  clear(guildId: string, userId: string): Promise<void>;
}
