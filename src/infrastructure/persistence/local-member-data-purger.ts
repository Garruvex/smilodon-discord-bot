import type { MemberDataPurger } from "../../application/members/member-data-purger.js";
import type { BirthdayStore } from "../../application/birthdays/birthday-store.js";
import type { MemoryRepository } from "../../application/memory/memory.js";
import type { ReminderStore } from "../../application/reminders/reminder-store.js";
import type { UserCustomizationStore } from "../../application/chat/user-customization-store.js";

// No guild_members hub table on this backend (see persistence-factory.ts),
// so each per-user store is purged directly instead of relying on a cascade.
export class LocalMemberDataPurger implements MemberDataPurger {
  public constructor(
    private readonly memoryRepository: MemoryRepository,
    private readonly userCustomizationStore: UserCustomizationStore,
    private readonly birthdayStore: BirthdayStore,
    private readonly reminderStore: ReminderStore,
  ) {}

  public async purge(guildId: string, userId: string): Promise<void> {
    await this.memoryRepository.forget({ guildId, ownerUserId: userId });
    await this.userCustomizationStore.clear(guildId, userId);
    await this.birthdayStore.removeBirthday(guildId, userId);
    // ReminderStore has no bulk "delete all for user" — list then cancel
    // each one individually.
    const reminders = await this.reminderStore.listForUser(guildId, userId);
    for (const reminder of reminders) {
      await this.reminderStore.cancel(reminder.id, userId);
    }
  }
}
