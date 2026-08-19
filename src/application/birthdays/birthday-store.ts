export interface BirthdayRecord {
  userId: string;
  month: number;
  day: number;
}

export interface BirthdayStore {
  initialize(): Promise<void>;
  setBirthday(guildId: string, userId: string, month: number, day: number): Promise<void>;
  removeBirthday(guildId: string, userId: string): Promise<boolean>;
  getBirthday(guildId: string, userId: string): Promise<BirthdayRecord | null>;
  listForGuildOnDate(guildId: string, month: number, day: number): Promise<readonly string[]>;
  hasAnnounced(guildId: string, date: string): Promise<boolean>;
  markAnnounced(guildId: string, date: string): Promise<void>;
}
