import { describe, expect, it, vi } from "vitest";
import { BirthdayMemberSetTool } from "../../src/application/chat/tools/birthday-member-set-tool.js";
import type { BirthdayStore } from "../../src/application/birthdays/birthday-store.js";
import type { ChatToolContext } from "../../src/application/chat/tools/chat-tool.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";

const context: ChatToolContext = {
  guildId: "guild", channelId: "channel", currentUser: { id: "actor", displayName: "Admin", roleNames: [] },
  channelIsNsfw: false, channelMode: "shared", isOwner: false, music: null, pendingGeneratedImages: [],
};
const date = { userId: "123456789012345678", month: 8, day: 17, birthYear: 1999, message: "Happy {birthday}, {member}!" };

describe("BirthdayMemberSetTool", () => {
  it.each([
    { admin: true, member: true, enabled: true, aborted: false, saved: true },
    { admin: false, member: true, enabled: true, aborted: false, saved: false },
    { admin: true, member: false, enabled: true, aborted: false, saved: false },
    { admin: true, member: true, enabled: false, aborted: false, saved: false },
    { admin: true, member: true, enabled: true, aborted: true, saved: false },
  ])("enforces member birthday access: %j", async ({ admin, member, enabled, aborted, saved }) => {
    const setBirthday = vi.fn().mockResolvedValue(undefined);
    const store = { setBirthday, getBirthday: vi.fn().mockResolvedValue(null) } as unknown as BirthdayStore;
    const profile = { features: { birthdays: enabled }, roles: { botAdministrator: new Set(["admin-role"]) }, timezone: "UTC" } as unknown as GuildConfiguration;
    const resolve = vi.fn((_guildId: string, userId: string): Promise<readonly string[] | null> =>
      Promise.resolve(userId === "actor" ? (admin ? ["admin-role"] : []) : member ? [] : null));
    const tool = new BirthdayMemberSetTool(store, { find: (): GuildConfiguration => profile }, resolve);
    const controller = new AbortController();
    if (aborted) controller.abort();

    const result = await tool.execute(date, { ...context, signal: controller.signal });

    if (saved) {
      expect(setBirthday).toHaveBeenCalledExactlyOnceWith("guild", date.userId, 8, 17, { birthYear: 1999, message: date.message });
      expect(JSON.parse(result.content)).toMatchObject({ saved: true, userId: date.userId });
    } else {
      expect(setBirthday).not.toHaveBeenCalled();
      expect(result.content).toContain("nothing was saved");
    }
  });
});
