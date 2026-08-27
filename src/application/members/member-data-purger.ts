// Deletes every piece of per-user data this bot holds for a guild member —
// chat memories, birthday, customization, reminders — in one call. Backed by
// a different implementation per persistence driver (see
// infrastructure/persistence/postgres-member-data-purger.ts and
// local-member-data-purger.ts) so MemberDepartureService doesn't need to
// know which backend is active.
export interface MemberDataPurger {
  purge(guildId: string, userId: string): Promise<void>;
}
