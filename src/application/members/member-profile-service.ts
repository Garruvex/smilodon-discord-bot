import type { Memory, MemoryEngine } from "../memory/memory.js";
import type { UserCustomizationStore } from "../chat/user-customization-store.js";
import type { BirthdayRecord, BirthdayStore } from "../birthdays/birthday-store.js";

export interface MemberProfile {
  memories: readonly Memory[];
  birthday: BirthdayRecord | null;
  customization: string | null;
}

// Assembles the three currently-disconnected per-member stores into one
// view, for both /memory list (so a user can see everything the bot knows
// about them in one place) and the AI chat context (so the bot can draw on
// birthday/customization the same turn it draws on memories). Read-only —
// each field is still owned and mutated by its existing dedicated store
// (MemoryEngine, BirthdayStore, UserCustomizationStore); this doesn't
// introduce a new write path or a merged schema.
export class MemberProfileService {
  public constructor(
    private readonly memoryEngine: MemoryEngine,
    private readonly birthdayStore: BirthdayStore | null,
    private readonly userCustomizationStore: UserCustomizationStore | null,
  ) {}

  public async load(guildId: string, userId: string): Promise<MemberProfile> {
    const [memories, birthday, customization] = await Promise.all([
      this.memoryEngine.listUserMemories(guildId, userId),
      this.birthdayStore?.getBirthday(guildId, userId) ?? Promise.resolve(null),
      this.userCustomizationStore?.load(guildId, userId) ?? Promise.resolve(null),
    ]);
    return { memories, birthday, customization };
  }
}
