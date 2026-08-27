// Deletes private, user-owned data this bot holds for a guild member — private
// memories, chat sessions/preferences, birthday, customization, and reminders
// — while retaining shared guild/channel memories. Backed by a different
// implementation per persistence driver (see
// infrastructure/persistence/postgres-member-data-purger.ts and
// local-member-data-purger.ts) so MemberDepartureService doesn't need to
// know which backend is active.
export interface MemberDataPurger {
  purge(guildId: string, userId: string): Promise<void>;
}
