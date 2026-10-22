import { describe, expect, it } from "vitest";
import { resolveConversationTurnPlan } from "../../src/application/chat/conversation-turn-plan.js";
import { characterSettings, characterSettingsSchema } from "../../src/application/chat/character-settings.js";
import { freshProfile } from "../helpers/settings-fixtures.js";

describe("one conversation plan", () => {
  it("always uses guarded text context sized from the context settings", () => {
    const profile = freshProfile();
    expect(resolveConversationTurnPlan(profile, "channel")).toEqual({ context: "guarded_text", deadlineMs: 30000, contextPolicy: { count: 40, budget: 12000 } });
    profile.character = { ...characterSettings(profile), context: { ...characterSettings(profile).context, maxMessages: 20, budget: 6000 } };
    expect(resolveConversationTurnPlan(profile, "channel").contextPolicy).toEqual({ count: 20, budget: 6000 });
  });
  it("ignores retired flow and time-window fields in stored configuration", () => {
    const parsed = characterSettingsSchema.parse({ context: { retrievalMode: "legacy", windowMinutes: 5, segmentGapMinutes: 3, summary: true, shadow: false, enabled: true, maxMessages: 24 } });
    expect(parsed.context).toEqual({ maxMessages: 24, budget: 12000, decisionMessages: 10 });
  });
});
