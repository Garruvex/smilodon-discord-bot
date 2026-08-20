import type { ChatMemoryRecord } from "../chat/chat-provider.js";
import type { ChatStateStore } from "../chat/chat-state-store.js";
import type { UserCustomizationStore } from "../chat/user-customization-store.js";
import type { BirthdayRecord, BirthdayStore } from "../birthdays/birthday-store.js";

export interface MemberProfile {
  memories: readonly ChatMemoryRecord[];
  birthday: BirthdayRecord | null;
  customization: string | null;
}

// Assembles the three currently-disconnected per-member stores into one
// view, for both /memory list (so a user can see everything the bot knows
// about them in one place) and the AI chat context (so the bot can draw on
// birthday/customization the same turn it draws on memories). Read-only —
// each field is still owned and mutated by its existing dedicated store
// (ChatStateStore, BirthdayStore, UserCustomizationStore); this doesn't
// introduce a new write path or a merged schema.
export class MemberProfileService {
  public constructor(
    private readonly chatStateStore: ChatStateStore,
    private readonly birthdayStore: BirthdayStore | null,
    private readonly userCustomizationStore: UserCustomizationStore | null,
  ) {}

  public async load(guildId: string, userId: string, now: number): Promise<MemberProfile> {
    const [state, birthday, customization] = await Promise.all([
      // Only `.memories` (guild+user scoped) is used below — `.exchanges`
      // would be channel-scoped, but this view isn't tied to any one
      // channel, so an empty channelId is passed (matches no real session,
      // exchanges come back empty, which is fine since they're unused here).
      this.chatStateStore.load(guildId, userId, "", now),
      this.birthdayStore?.getBirthday(guildId, userId) ?? Promise.resolve(null),
      this.userCustomizationStore?.load(guildId, userId) ?? Promise.resolve(null),
    ]);
    return { memories: state.memories, birthday, customization };
  }
}
