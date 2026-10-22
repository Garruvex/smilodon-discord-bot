import type { GuildMember } from "discord.js";
import { describe, expect, it } from "vitest";
import { admitChat, chatInteractions, ChatPolicy } from "../../src/application/chat/chat-policy.js";
import { defaultParticipation } from "../../src/application/chat/participation-policy.js";
import { chatDiagnosticRecordSchema } from "../../src/application/diagnostics/chat-diagnostics.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import { diagnosticRecord } from "../helpers/chat-trace-fixtures.js";
import { freshProfile } from "../helpers/settings-fixtures.js";

const channelId = "500000000000000001";
const owner = "100000000000000009";
const policy = new ChatPolicy({ ownerUserIds: new Set([owner]) } as unknown as ApplicationConfiguration);
function profile(): ReturnType<typeof freshProfile> {
  const p = freshProfile(); p.features.chatbot = true; p.features.channelHistory = true; p.features.ambientReplies = true; p.features.reactionReplies = true;
  p.channels.chatbot = new Set([channelId]);
  p.chat.participation = { ...defaultParticipation, continuationEnabled: true, spontaneousEnabled: true, spontaneousChannelIds: [channelId] };
  return p;
}
const member = (...roles: string[]): GuildMember => ({ roles: { cache: new Map(roles.map((role) => [role, {}])) } }) as unknown as GuildMember;
const human = (roles: string[] = ["200000000000000001"], userId = "human"): { userId: string; bot: false; member: GuildMember } => ({ userId, bot: false, member: member(...roles) });

describe("ChatPolicy.admit", () => {
  it("gives an authorized member the same result the configuration explanation shows", () => {
    for (const configure of [(): void => undefined, (p: ReturnType<typeof profile>): void => { p.features.channelHistory = false; },
      (p: ReturnType<typeof profile>): void => { p.channels.chatbot = new Set(["elsewhere"]); },
      (p: ReturnType<typeof profile>): void => { p.chat.participation = { ...defaultParticipation }; p.features.ambientReplies = false; }]) {
      const p = profile(); configure(p);
      for (const interaction of chatInteractions.filter((item) => item !== "reaction")) {
        expect(policy.admit(p, channelId, interaction, human()).reasons).toEqual(admitChat(p, channelId, interaction).reasons);
      }
      expect(policy.admit(p, channelId, "reaction", { userId: "bot", bot: true, member: null }).reasons)
        .toEqual(admitChat(p, channelId, "reaction").reasons.filter((reason) => reason !== "channel_denied"));
    }
  });

  it("separates explicit requests from passive reading", () => {
    const p = profile(); p.features.channelHistory = false; p.chat.channelMemoryModes = { [channelId]: "disabled" };
    expect(policy.admit(p, channelId, "direct_mention", human()).admitted).toBe(true);
    expect(policy.admit(p, channelId, "name_address", human()).admitted).toBe(true);
    expect(policy.admit(p, channelId, "implicit_followup", human()).reasons).toEqual(["history_disabled", "memory_disabled"]);
    expect(policy.admit(p, channelId, "observation", human()).reasons).toEqual(["history_disabled", "memory_disabled"]);
  });

  it("reports every disabled control and keeps group participation behind its channel list", () => {
    const p = profile(); p.features.ambientReplies = false; p.features.reactionReplies = false;
    p.chat.participation = { ...defaultParticipation, spontaneousEnabled: true, spontaneousChannelIds: [] };
    expect(policy.admit(p, channelId, "name_address", human()).reasons[0]).toBe("ambient_disabled");
    expect(policy.admit(p, channelId, "implicit_followup", human()).reasons[0]).toBe("continuation_disabled");
    expect(policy.admit(p, channelId, "group_conversation", human()).reasons).toEqual(["spontaneous_not_selected"]);
    expect(admitChat(p, channelId, "reaction").reasons).toContain("reaction_disabled");
  });

  it("lets owners bypass the channel allow-list but never collection opt-outs", () => {
    const p = profile(); p.channels.chatbot = new Set(["elsewhere"]);
    expect(policy.admit(p, channelId, "direct_mention", human([], owner)).admitted).toBe(true);
    expect(policy.admit(p, channelId, "direct_mention", human()).reasons[0]).toBe("channel_denied");
    p.chat.contextOptOutUserIds = [owner];
    expect(policy.admit(p, channelId, "direct_mention", human([], owner)).reasons[0]).toBe("context_opt_out");
  });

  it("reports member access reasons and requires bot-authored reaction targets", () => {
    const p = profile();
    expect(policy.admit(p, channelId, "direct_mention", human([])).reasons[0]).toBe("missing_chat_role");
    expect(policy.admit(p, channelId, "direct_mention", { userId: "human", bot: false, member: null }).reasons[0]).toBe("member_unavailable");
    expect(policy.admit(p, channelId, "reaction", human()).reasons).toContain("unknown_bot_output");
    expect(policy.admit(p, channelId, "reaction", { userId: "bot", bot: true, member: null }).admitted).toBe(true);
  });

  it("scopes background observation by scan selection rather than live participation", () => {
    const p = profile(); p.features.channelHistory = false;
    expect(policy.admit(p, channelId, "background_observation", human()).reasons[0]).toBe("background_scope_denied");
    p.chat.contextScanChannelIds = [channelId];
    expect(policy.admit(p, channelId, "background_observation", human([])).admitted).toBe(true);
    p.chat.contextOptOutUserIds = ["human"];
    expect(policy.admit(p, channelId, "background_observation", human()).reasons[0]).toBe("context_opt_out");
  });
});

describe("persisted interaction diagnostics", () => {
  it("upgrades traces recorded with the retired trigger names", () => {
    const legacy = { ...diagnosticRecord(), data: { event: "chat.turn.completed", triggerMode: "ambient", outcome: "suppressed", durationMs: 1, textDeliveryConfirmed: false } };
    expect(chatDiagnosticRecordSchema.parse(legacy).data).toMatchObject({ event: "chat.turn.completed", interaction: "name_address" });
    const denied = { ...diagnosticRecord(), data: { event: "context.eligibility.denied", sourceMessageId: "source", purpose: "continuation", reason: "access_denied" } };
    expect(chatDiagnosticRecordSchema.parse(denied).data).toMatchObject({ purpose: "implicit_followup" });
  });
});
