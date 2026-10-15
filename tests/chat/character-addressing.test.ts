import { describe, expect, it } from "vitest";
import { allowsOptionalParticipation, localAddressing, type CharacterDecision } from "../../src/application/chat/character-decision.js";
import type { ChannelHistoryMessage } from "../../src/application/chat/chat-provider.js";

function event(messageId: string, authorId: string, timestampMs: number, extra: Partial<ChannelHistoryMessage> = {}): ChannelHistoryMessage {
  return { messageId, authorId, authorDisplayName: authorId, timestampMs, content: "你覺得呢？", imageCount: 0, ...extra };
}
const decision: CharacterDecision = { addressing: "continuing", confidence: 0.9, motivation: 0.8, boundary: "earlier", target: "current", reaction: null, thoughts: [], recipientEvidence: ["current"], recipientConfidence: 0.9, targetConfidence: 0.9, opening: "clear", contribution: { text: "A specific observation", adds: "A new detail", label: "useful-observation", sourceMessageId: "current", recipientId: "alice", motivation: 0.8 } };

describe("implicit addressees", () => {
  const human = event("human", "alice", 1000);
  const bot = event("bot-message", "bot", 2000, { replyToAuthorId: "alice", replyToMessageId: "human" });
  const current = event("current", "alice", 4000);
  it("continues an uninterrupted exchange without treating a question as explicit addressing", () => {
    expect(localAddressing([human, bot, current], current, "bot", false)).toBe("continuing");
  });
  it("abstains after another person enters the conversation", () => {
    expect(localAddressing([human, bot, event("bob", "bob", 3000), current], current, "bot", true)).toBe("unclear");
  });
  it("does not transfer a fresh continuation to a different human, regardless of wording", () => {
    for (const content of ["你也要當跑山猴嗎", "那下繞呢", "why?"]) {
      const other = { ...current, timestampMs: bot.timestampMs + 1, authorId: "bob", content };
      expect(localAddressing([human, bot], other, "bot", true)).toBe("unclear");
      expect(allowsOptionalParticipation("continuation", "unclear", decision, false)).toBe(false);
      expect(localAddressing([human, bot], { ...other, replyToMessageId: bot.messageId }, "bot", true)).toBe("bot");
    }
  });
  it("does not count the current or future message as prior participation", () => {
    expect(localAddressing([event("bot", "bot", 2000), current, event("future", "alice", 5000)], current, "bot", true)).toBe("unclear");
    expect(localAddressing([event("future", "bot", 5000, { replyToAuthorId: "alice" })], current, "bot", true)).toBe("unclear");
  });
  it("respects replies and mentions to another person even during a bot exchange", () => {
    expect(localAddressing([human, bot, event("bob", "bob", 1000)], { ...current, replyToMessageId: "bob" }, "bot", true)).toBe("others");
    expect(localAddressing([human, bot], { ...current, content: "<@123456789012345678> 你覺得呢？" }, "bot", true)).toBe("others");
    expect(localAddressing([human, bot], { ...current, replyToMessageId: "unknown" }, "bot", true)).toBe("unclear");
  });
  it("recognizes an explicit reply to the bot even after the implicit window expires", () => {
    expect(localAddressing([human, bot], { ...current, timestampMs: 200000, replyToMessageId: bot.messageId }, "bot", false)).toBe("bot");
  });
  it.each(["你也要當跑山猴嗎", "妳也要去嗎", "那你也要改嗎", "Are you going too?", "What do you think?", "あなたも行く？"])("does not assign an unresolved personal address to the bot: %s", (content) => {
    const late = { ...current, authorId: "bystander", timestampMs: 6 * 60 * 60 * 1000, content };
    expect(localAddressing([human, bot], late, "bot", true)).toBe("unclear");
    expect(localAddressing([], late, "bot", true)).toBe("unclear");
    expect(localAddressing([human, bot], { ...late, replyToMessageId: bot.messageId }, "bot", true)).toBe("bot");
  });
  it("keeps open group questions eligible for a distinct spontaneous contribution", () => {
    expect(localAddressing([], { ...current, content: "你們有推薦的活動嗎？" }, "bot", true)).toBe("others");
    expect(localAddressing([], { ...current, content: "Are you all joining?" }, "bot", true)).toBe("others");
  });
});

describe("optional participation admission", () => {
  it("cannot revive an ambiguous or redirected continuation with a confident model decision", () => {
    expect(allowsOptionalParticipation("continuation", "unclear", decision, false)).toBe(false);
    expect(allowsOptionalParticipation("continuation", "continuing", decision, true)).toBe(false);
    expect(allowsOptionalParticipation("continuation", "continuing", { ...decision, addressing: "others" }, false)).toBe(false);
  });
  it("requires confidence and a strong contribution for spontaneous speech", () => {
    expect(allowsOptionalParticipation("spontaneous", "others", null, false)).toBe(false);
    expect(allowsOptionalParticipation("spontaneous", "others", { ...decision, contribution: { ...decision.contribution, motivation: 0.5 } }, false)).toBe(false);
    expect(allowsOptionalParticipation("spontaneous", "others", { ...decision, confidence: 0.6 }, false)).toBe(false);
    expect(allowsOptionalParticipation("spontaneous", "others", { ...decision, addressing: "unclear" }, false)).toBe(false);
    expect(allowsOptionalParticipation("spontaneous", "others", { ...decision, addressing: "others" }, false)).toBe(true);
  });
  it("abstains on optional followups if the decision provider fails", () => {
    expect(allowsOptionalParticipation("continuation", "continuing", null, false)).toBe(false);
  });
  it.each(["bot", "continuing"] as const)("does not let a spontaneous model decision invent %s addressing", (addressing) => {
    expect(allowsOptionalParticipation("spontaneous", "others", { ...decision, addressing }, false)).toBe(false);
  });
});
