import { describe, expect, it } from "vitest";
import { classifySimpleTurn } from "../../src/application/chat/simple-exchange.js";
import { exchangeIdleMs } from "../../src/application/chat/exchange-window.js";
import type { ChannelHistoryMessage } from "../../src/application/chat/chat-provider.js";

const start = 1_000_000;
const message = (messageId: string, timestampMs: number, authorId: string, content = "hello", extra: Partial<ChannelHistoryMessage> = {}): ChannelHistoryMessage =>
  ({ messageId, timestampMs, authorId, authorDisplayName: authorId, content, imageCount: 0, ...extra });
const answered = (at: number, to = "alice"): ChannelHistoryMessage[] => [
  message("ask", at - 2000, to, "can you check this"),
  message("answer", at - 1000, "bot", "sure", { replyToMessageId: "ask", replyToAuthorId: to }),
];
const classify = (current: ChannelHistoryMessage, events: ChannelHistoryMessage[], startedAt = 0): ReturnType<typeof classifySimpleTurn> => classifySimpleTurn({ events, current, botId: "bot", startedAt });

describe("simple participation classification", () => {
  it("is joining when the bot has not spoken to this person", () => {
    expect(classify(message("now", start, "alice", "anyone play tonight"), [message("a", start - 5000, "bob", "hi")])).toMatchObject({ kind: "joining", basis: null });
  });
  it("links a reply chain into an exchange with a bot reply to this author, however old", () => {
    const events = answered(start - 6 * 60 * 60 * 1000);
    const current = message("now", start, "alice", "also this", { replyToMessageId: "answer", replyToAuthorId: "bot" });
    expect(classify(current, events)).toMatchObject({ kind: "followup", basis: "linked", anchorMessageId: "answer" });
    expect(classify({ ...current, replyToMessageId: "ask", replyToAuthorId: "alice" }, events)).toMatchObject({ kind: "followup", basis: "linked" });
  });
  it("does not let another human's exchange confer a linked binding", () => {
    const events = answered(start - 5000, "bob");
    const current = message("now", start, "alice", "wait what", { replyToMessageId: "answer", replyToAuthorId: "bot" });
    expect(classify(current, events)).toMatchObject({ kind: "joining" });
  });
  it("opens an exchange for an unlinked message inside the idle window, inclusive at the boundary", () => {
    const events = answered(start);
    const anchor = start - 1000;
    expect(classify(message("now", anchor + exchangeIdleMs, "alice", "and tomorrow?"), events)).toMatchObject({ kind: "followup", basis: "open_exchange", anchorMessageId: "answer" });
    expect(classify(message("late", anchor + exchangeIdleMs + 1, "alice", "and tomorrow?"), events)).toMatchObject({ kind: "joining" });
  });
  it("closes an open exchange when the anchor predates process start", () => {
    const events = answered(start);
    expect(classify(message("now", start, "alice", "and tomorrow?"), events, start + 1)).toMatchObject({ kind: "joining" });
    expect(classify(message("now", start, "alice", "and tomorrow?"), events, start - 1000)).toMatchObject({ kind: "followup", basis: "open_exchange" });
  });
  it("does not carry an exchange to another person or past the bot answering someone else", () => {
    const events = answered(start);
    expect(classify(message("now", start, "bob", "and you?"), events)).toMatchObject({ kind: "joining" });
    const later = [...events, message("other", start - 500, "bob", "q"), message("other-answer", start - 400, "bot", "a", { replyToMessageId: "other", replyToAuthorId: "bob" })];
    expect(classify(message("now", start, "alice", "and tomorrow?"), later)).toMatchObject({ kind: "joining" });
  });
  it("ends an open exchange when this author addressed another human in between", () => {
    const events = [...answered(start), message("aside", start - 500, "alice", "ok", { replyToMessageId: "bobmsg", replyToAuthorId: "bob" })];
    expect(classify(message("now", start, "alice", "so then?"), events)).toMatchObject({ kind: "joining" });
  });
  it("excludes an explicit recipient correction and a reply to another human, even inside a bot exchange", () => {
    const events = [...answered(start), message("bobmsg", start - 800, "bob", "hey alice")];
    expect(classify(message("now", start, "alice", "I'm not talking to you"), events)).toEqual({ excluded: "recipient_correction" });
    expect(classify(message("now", start, "alice", "yes sure", { replyToMessageId: "bobmsg", replyToAuthorId: "bob" }), events)).toEqual({ excluded: "addressed_elsewhere" });
    expect(classify(message("now", start, "alice", "<@123> check this"), events)).toEqual({ excluded: "addressed_elsewhere" });
  });
  it("treats a reply to the author's own message as no exclusion", () => {
    const events = answered(start - 4000);
    const current = message("now", start, "alice", "one more thing", { replyToMessageId: "ask", replyToAuthorId: "alice" });
    expect(classify(current, events)).toMatchObject({ kind: "followup", basis: "linked" });
  });
});
