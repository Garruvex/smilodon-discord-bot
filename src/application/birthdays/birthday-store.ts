export interface BirthdayRecord {
  userId: string;
  month: number;
  day: number;
  birthYear?: number | null | undefined;
  message?: string | null | undefined;
}

export interface BirthdayDetails {
  birthYear?: number | null | undefined;
  message?: string | null | undefined;
}

export interface BirthdayStore {
  initialize(): Promise<void>;
  setBirthday(guildId: string, userId: string, month: number, day: number, details?: BirthdayDetails): Promise<void>;
  removeBirthday(guildId: string, userId: string): Promise<boolean>;
  getBirthday(guildId: string, userId: string): Promise<BirthdayRecord | null>;
  listForGuildOnDate(guildId: string, month: number, day: number): Promise<readonly string[]>;
  listAllForGuild(guildId: string): Promise<readonly BirthdayRecord[]>;
  hasAnnounced(guildId: string, date: string): Promise<boolean>;
  markAnnounced(guildId: string, date: string): Promise<void>;
}
