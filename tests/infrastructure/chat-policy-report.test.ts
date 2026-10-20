import type { Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { effectiveChatPolicy } from "../../src/application/chat/effective-chat-policy.js";
import { characterSettings } from "../../src/application/chat/character-settings.js";
import { defaultParticipation } from "../../src/application/chat/participation-policy.js";
import { settingsText } from "../../src/application/i18n/settings/index.js";
import { renderChatPolicy } from "../../src/infrastructure/discord/settings/groups/chat-policy-report.js";
import { actorUserId, engineFixture, freshProfile, guildId, slashValues } from "../helpers/settings-fixtures.js";

const channelId = "500000000000000001";
const readiness = { reply: true, decision: true, botRead: true };
function profile(): ReturnType<typeof freshProfile> {
  const p = freshProfile(); p.features.chatbot = true; p.features.channelHistory = true;
  p.channels.chatbot = new Set([channelId]);
  p.character = { ...characterSettings(p), context: { ...characterSettings(p).context, enabled: true, retrievalMode: "eligible_count" } };
  return p;
}

describe("effective chat policy", () => {
  it("does not invent a legacy direct-chat history prerequisite", () => {
    const p = profile(); p.character!.context.retrievalMode = "legacy";
    const policy = effectiveChatPolicy(p, channelId, { ...readiness, botRead: false });
    expect(policy.historyReasons).toContain("bot_cannot_read");
    expect(policy.modes[0]?.reasons).not.toContain("bot_cannot_read");
  });

  it("keeps thread selection exact, resolves inheritance, and does not grant observation from an empty direct allow-list", () => {
    const p = profile();
    expect(effectiveChatPolicy(p, channelId, readiness).historyReasons).toEqual([]);
    const thread = effectiveChatPolicy(p, "thread", readiness);
    expect(thread.historyReasons).toContain("observation_not_selected");
    expect(thread.modes.find((mode) => mode.mode === "direct")?.reasons).toContain("channel_not_selected");
    p.channels.chatbot = new Set();
    const empty = effectiveChatPolicy(p, channelId, readiness);
    expect(empty.modes[0]?.reasons).toEqual([]);
    expect(empty.historyReasons).toContain("observation_not_selected");
    p.chat.participation = { ...defaultParticipation, observationChannelIds: [] };
    expect(effectiveChatPolicy(p, channelId, readiness).observationInherited).toBe(false);
  });

  it("shows enabled controls blocked by dependencies and honors per-channel overrides", () => {
    const p = profile();
    p.chat.participation = { ...defaultParticipation, continuationEnabled: true, spontaneousEnabled: true,
      spontaneousChannelIds: [], channelOverrides: { [channelId]: { activity: "quiet", continuationEnabled: false } } };
    p.character!.channelOverrides[channelId] = { modules: {}, contextEnabled: false };
    const policy = effectiveChatPolicy(p, channelId, { reply: true, decision: false, botRead: false });
    expect(policy.modes.find((mode) => mode.mode === "spontaneous")?.reasons).toEqual(expect.arrayContaining(["spontaneous_not_selected", "decision_unavailable", "context_channel_disabled", "bot_cannot_read"]));
    expect(policy.modes.find((mode) => mode.mode === "continuation")?.reasons).toContain("feature_disabled");
    expect(policy.participation.activity).toBe("quiet"); expect(policy.participation.limits.textCooldownMs).toBe(120000);
    expect(policy.participationOverrides).toEqual(["activity", "continuationEnabled"]);
    expect(policy.contextOverride).toBe(true);
  });

  it("reports guarded exclusions even when history is off and keeps background scope independent", () => {
    const p = profile(); p.features.channelHistory = false; p.chat.contextDailyChannelIds = [channelId];
    const policy = effectiveChatPolicy(p, channelId, readiness);
    expect(policy.guarded).toBe(true); expect(policy.historyReasons).toContain("history_disabled");
    expect(policy.daily).toBe(true); expect(policy.scan).toBe(false);
    p.chat.channelMemoryModes = { [channelId]: "disabled" };
    expect(effectiveChatPolicy(p, channelId, readiness).historyReasons).toContain("memory_disabled");
  });

  it("preserves shadow delivery status for ambient, optional and reaction turns", () => {
    const p = profile(); p.features.ambientReplies = true; p.features.reactionReplies = true;
    p.chat.participation = { ...defaultParticipation, continuationEnabled: true, spontaneousEnabled: true, spontaneousChannelIds: [channelId], shadowMode: true };
    const modes = effectiveChatPolicy(p, channelId, readiness).modes;
    expect(modes.filter((mode) => mode.shadow).map((mode) => mode.mode)).toEqual(["name_address", "continuation", "spontaneous", "reaction"]);
    expect(modes[0]?.shadow).toBe(false);
  });

  it.each(["en", "zh-TW", "ja"] as const)("keeps every %s view localized and within Discord content limits", (language) => {
    const p = profile(); p.features.chatbot = false; p.features.channelHistory = false;
    p.chat.channelMemoryModes = { [channelId]: "disabled" };
    p.character!.channelOverrides[channelId] = { modules: {}, contextEnabled: false };
    const text = settingsText(language); const original = JSON.stringify(p);
    for (const view of ["overview", "context", "activity"]) {
      const result = renderChatPolicy({ profile: p, text }, channelId, { reply: false, decision: false, botRead: false }, view);
      expect(result.length).toBeLessThanOrEqual(2000); expect(result).not.toMatch(/\{\w+\}/u);
      expect(result).not.toContain("participation.policy");
    }
    expect(JSON.stringify(p)).toBe(original);
    expect(renderChatPolicy({ profile: p, text }, channelId, readiness, "context")).toContain(text.message("participation.policy", "exclusions"));
  });
});

describe("protected policy settings report", () => {
  it("persists a pilot flow and shadow override without changing other channels", async () => {
    const fixture = engineFixture();
    await fixture.run("participation.participation-channel", slashValues({ channel: { id: channelId }, "flow-version": "contextual_v1", shadow: true }));
    expect(fixture.profiles.current().chat.participation?.channelOverrides[channelId]).toMatchObject({ flowVersion: "contextual_v1", shadowMode: true });
    expect(fixture.profiles.current().chat.participation?.flowVersion).toBe("legacy");
    expect(fixture.profiles.current().chat.participation?.channelOverrides["500000000000000099"]).toBeUndefined();
  });
  it("requires explicit thread observation before selecting a contextual pilot", async () => {
    const fixture = engineFixture(); const id = "500000000000000099";
    const guild = { id: guildId, channels: { fetch: () => Promise.resolve({ guildId, isThread: () => true }) } } as unknown as Guild;
    const setting = fixture.engine.find("participation.thread-scope")!;
    await fixture.engine.run(setting, { guildId, guild, actorUserId, language: "en", values: slashValues({ "thread-id": id, "flow-version": "contextual_v1", shadow: true }) }, { kind: "panel" });
    expect(fixture.profiles.current().chat.participation?.channelOverrides[id]).toBeUndefined();
    await fixture.engine.run(setting, { guildId, guild, actorUserId, language: "en", values: slashValues({ "thread-id": id, observe: true, "flow-version": "contextual_v1", shadow: true }) }, { kind: "panel" });
    expect(fixture.profiles.current().chat.participation?.observationChannelIds).toContain(id);
    expect(fixture.profiles.current().chat.participation?.channelOverrides[id]).toMatchObject({ flowVersion: "contextual_v1", shadowMode: true });
  });
  function fixture(allowed = true): { run: () => Promise<string>; fetch: ReturnType<typeof vi.fn> } {
    const { engine } = engineFixture({ deps: { chatProviderAvailable: true } });
    const fetch = vi.fn(() => Promise.resolve({ guildId, isTextBased: () => true, permissionsFor: (member: { id: string }): { has: () => boolean } => ({ has: () => member.id === "bot" || allowed }) }));
    const guild = { id: guildId, channels: { fetch }, members: { fetch: () => Promise.resolve({ id: actorUserId }), fetchMe: () => Promise.resolve({ id: "bot" }) } } as unknown as Guild;
    const run = async (): Promise<string> => {
      const result = await engine.run(engine.find("participation.policy")!, { guildId, guild, actorUserId, language: "en", values: slashValues({ channel: { id: channelId } }) }, { kind: "panel" });
      if (result.kind !== "report") throw new Error(result.kind);
      return result.text;
    };
    return { run, fetch };
  }
  it("refreshes access and renders a read-only report", async () => {
    const { run, fetch } = fixture();
    expect(await run()).toContain("Chat policy for"); expect(fetch).toHaveBeenCalledWith(channelId, { force: true });
  });
  it("denies unreadable channels and hides fetch errors", async () => {
    const { run, fetch } = fixture(false);
    expect(await run()).toContain("could not be verified");
    fetch.mockRejectedValue(new Error("SECRET_CHANNEL_ERROR"));
    const result = await run(); expect(result).toContain("could not be verified"); expect(result).not.toContain("SECRET");
  });
  it("does not select an arbitrary channel when the panel has no parameters", async () => {
    const fixture = engineFixture();
    const result = await fixture.run("participation.policy", slashValues({}));
    expect(result.kind).toBe("report");
    if (result.kind === "report") expect(result.text).toContain("Choose a channel or thread");
  });
});
