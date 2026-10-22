import { describe, expect, it } from "vitest";
import { mentionInteraction, resolveConversationTrigger } from "../../src/application/chat/conversation-trigger.js";
import { addressedElsewhere, localAddressing } from "../../src/application/chat/character-decision.js";
describe("conversation trigger evidence", () => {
  it.each(["direct_mention", "explicit_reply", "bare_ping", "name_address", "implicit_followup", "group_conversation", "reaction"] as const)("represents %s with separate response and discussion identities", (interaction) => {
    const explicit = ["direct_mention", "explicit_reply", "bare_ping", "name_address"].includes(interaction);
    const result = resolveConversationTrigger({ interaction, sourceMessageId: "current", currentEvent: { type: "message", messageId: "current", channelId: "channel", authorId: "speaker", mentionedUserIds: [], timestampMs: 1, replyToMessageId: "discussed" } });
    expect(result).toEqual({ interaction, explicit, responseToEventId: "current", discussedMessageId: "discussed" });
  });
  it("lets an explicit bot mention override a human reply target", () => {
    const current = { messageId: "current", timestampMs: 2, authorId: "speaker", authorDisplayName: "Speaker", content: "<@123> what about this?", imageCount: 0, replyToMessageId: "human", replyToAuthorId: "another" };
    expect(localAddressing([], current, "123")).toBe("bot");
    expect(addressedElsewhere(current, [], "123")).toBe(false);
    expect(mentionInteraction("<@123>", "123", false)).toBe("bare_ping");
  });
});
