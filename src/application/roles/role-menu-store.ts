export interface RoleMenuOption {
  roleId: string;
  label: string;
}

export interface RoleMenu {
  guildId: string;
  channelId: string;
  messageId: string;
  // The full set of roles this menu offers — handleSelect diffs a user's
  // submitted selection against this list to know what to add vs. remove.
  options: readonly RoleMenuOption[];
}

export interface RoleMenuStore {
  initialize(): Promise<void>;
  create(menu: RoleMenu): Promise<void>;
  find(messageId: string): Promise<RoleMenu | null>;
  listForGuild(guildId: string): Promise<readonly RoleMenu[]>;
  remove(messageId: string): Promise<boolean>;
}
