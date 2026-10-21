import { describe, expect, it } from "vitest";
import { resolveConversationTurnPlan } from "../../src/application/chat/conversation-turn-plan.js";
import { characterSettings } from "../../src/application/chat/character-settings.js";
import { defaultParticipation } from "../../src/application/chat/participation-policy.js";
import { freshProfile } from "../helpers/settings-fixtures.js";

describe("one effective conversation plan", () => {
  it.each(["context_disabled", "legacy_retrieval", "channel_context_disabled"] as const)("blocks an invalid contextual configuration instead of falling back: %s", (reason) => {
    const profile = freshProfile();
    profile.chat.participation = { ...defaultParticipation, flowVersion: "contextual_v1" };
    profile.character = { ...characterSettings(profile), context: { ...characterSettings(profile).context, enabled: reason !== "context_disabled", retrievalMode: reason === "legacy_retrieval" ? "legacy" : "eligible_count" } };
    if (reason === "channel_context_disabled") profile.character.channelOverrides.channel = { contextEnabled: false, modules: {} };
    expect(resolveConversationTurnPlan(profile, "channel")).toMatchObject({ state: "blocked", flow: "contextual_v1", reason });
  });
  it("uses one guarded boundary independently of participation rollout settings", () => {
    const profile = freshProfile();
    expect(resolveConversationTurnPlan(profile, "channel")).toMatchObject({ state: "ready", context: "guarded_text", decision: "legacy" });
    profile.character = { ...characterSettings(profile), context: { ...characterSettings(profile).context, enabled: true, retrievalMode: "eligible_count" } };
    expect(resolveConversationTurnPlan(profile, "channel")).toMatchObject({ state: "ready", context: "guarded_text", decision: "legacy", deadlineMs: 30000 });
    profile.chat.participation = { ...defaultParticipation, flowVersion: "contextual_v1" };
    expect(resolveConversationTurnPlan(profile, "channel")).toMatchObject({ state: "ready", context: "guarded_text", decision: "contextual", deadlineMs: 30000 });
  });
});
