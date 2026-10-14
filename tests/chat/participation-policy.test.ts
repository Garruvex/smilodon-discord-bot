import { describe, expect, it } from "vitest";
import { defaultParticipation, isLowSubstancePing, resolveParticipation } from "../../src/application/chat/participation-policy.js";
import { guildConfigurationFileSchema } from "../../src/config/guild-configuration-schema.js";
import { freshDocument } from "../helpers/settings-fixtures.js";

describe("participation policy", () => {
  it("keeps new unsolicited triggers off on schema upgrade", () => {
    const document = freshDocument();
    const { participation: _unused, ...oldChat } = document.chat;
    const upgraded = guildConfigurationFileSchema.parse({ ...document, chat: oldChat });
    expect(upgraded.chat.participation).toMatchObject({ continuationEnabled: false, spontaneousEnabled: false,
      spontaneousChannelIds: [], shadowMode: false, barePingMode: "acknowledge" });
  });
  it("inherits or overrides independently but cannot bypass the spontaneous allow-list", () => {
    const settings = { ...defaultParticipation, continuationEnabled: true, spontaneousEnabled: true, spontaneousChannelIds: ["allowed"],
      channelOverrides: { allowed: { continuationEnabled: false, activity: "quiet" as const }, denied: { spontaneousEnabled: true } } };
    expect(resolveParticipation(settings, "allowed")).toMatchObject({ continuationEnabled: false, spontaneousEnabled: true,
      limits: { textPerWindow: 1 } });
    expect(resolveParticipation(settings, "denied").spontaneousEnabled).toBe(false);
    expect(resolveParticipation(undefined, "allowed").continuationEnabled).toBe(false);
  });
  it("treats only low-content pings as optional, never questions, replies, or image requests", () => {
    expect(isLowSubstancePing("", false, false)).toBe(true);
    expect(isLowSubstancePing("hey", false, false)).toBe(true);
    expect(isLowSubstancePing("what about tomorrow?", false, false)).toBe(false);
    expect(isLowSubstancePing("?", true, false)).toBe(false);
    expect(isLowSubstancePing("", false, true)).toBe(false);
  });
});
