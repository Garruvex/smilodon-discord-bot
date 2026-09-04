import type { MemberDataPurger } from "../../application/members/member-data-purger.js";
import type { BirthdayStore } from "../../application/birthdays/birthday-store.js";
import type { ChatStateStore } from "../../application/chat/chat-state-store.js";
import type { MemoryRepository } from "../../application/memory/memory.js";
import type { ReminderStore } from "../../application/reminders/reminder-store.js";
import type { UserCustomizationStore } from "../../application/chat/user-customization-store.js";
import type { PersonalMemoryExtractionQueueStore } from "../../application/context/personal-memory-extraction-queue.js";

// No guild_members hub table on this backend (see persistence-factory.ts),
// so each per-user store is purged directly instead of relying on a cascade.
export class LocalMemberDataPurger implements MemberDataPurger {
  public constructor(
    private readonly memoryRepository: MemoryRepository,
    private readonly userCustomizationStore: UserCustomizationStore,
    private readonly birthdayStore: BirthdayStore,
    private readonly reminderStore: ReminderStore,
    private readonly chatStateStore: ChatStateStore,
    // A still-queued (or already-succeeded-but-not-yet-cleaned-up, see
    // PersonalMemoryExtractionQueueStore.markSucceeded) extraction job holds
    // this member's own raw message text and can later (re)create a private
    // memory for them after they've left, if left unpurged.
    private readonly personalMemoryExtractionQueueStore: PersonalMemoryExtractionQueueStore,
  ) {}

  public async purge(guildId: string, userId: string): Promise<void> {
    // No shared transaction across these independent stores (see class
    // comment), so a failure in one must not skip the rest — otherwise a
    // single store error would silently leave later stores unpurged with no
    // Discord event to retry against. Attempt all, then surface every
    // failure together.
    // Wrap every call in a microtask so a synchronous adapter exception
    // becomes a rejected promise instead of aborting construction of the
    // array before the remaining stores have even been attempted.
    const operations: readonly (() => Promise<unknown>)[] = [
      (): Promise<unknown> => this.memoryRepository.forget({ guildId, ownerUserId: userId }),
      (): Promise<unknown> => this.userCustomizationStore.clear(guildId, userId),
      (): Promise<unknown> => this.birthdayStore.removeBirthday(guildId, userId),
      (): Promise<unknown> => this.reminderStore.deleteForUser(guildId, userId),
      (): Promise<unknown> => this.chatStateStore.purgeUser(guildId, userId),
      (): Promise<unknown> => this.personalMemoryExtractionQueueStore.deleteForSubject(guildId, userId),
    ];
    const results = await Promise.allSettled(
      operations.map((operation) => Promise.resolve().then(() => operation())),
    );
    const failures = results.filter((result) => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Member data purge failed for ${failures.length} of ${results.length} stores`);
    }
  }
}
