import { describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
import { contextualDecisionContract } from "../../src/application/chat/contextual-decision-contract.js";
import { CharacterDecisionService } from "../../src/application/chat/character-decision.js";
import { branchHuman, branchBot, branchCurrent } from "../helpers/conversation-decision-fixtures.js";
import { contextualProposal } from "../helpers/contextual-decision-fixtures.js";
const events = [branchHuman, branchBot, branchCurrent];
describe("contextual decision binding", () => {
  it("offers different exchange-link types without letting a new speaker inherit another speaker's identity", () => {
    const other = { ...branchCurrent, authorId: "bob" };
    const contract = contextualDecisionContract([branchHuman, branchBot, other], "bot", other.messageId);
    expect(contract.links.map((item) => item.key)).toEqual(["reference_1"]);
    expect(() => contract.parse(contextualProposal({ linkKey: "speaker_1", recipientEvidence: ["original", "confirmed-reply", "current"] }))).toThrow();
    expect(contract.parse(contextualProposal({ linkKey: "reference_1" })).contextual?.link).toMatchObject({ kind: "bot_reference", humanEventId: "original", botEventId: "confirmed-reply" });
  });
  it("binds a reaction to its supplied bot target and reactor audience without a human target choice", () => {
    const snapshot = { type: "reaction_snapshot" as const, channelId: "channel", targetMessageId: "confirmed-reply", targetAuthorId: "bot", observedAt: 4000,
      complete: true, exactReactionTimes: "unknown" as const, reactions: [{ emoji: "👍", emojiId: null, actorIds: ["alice"] }] };
    const contract = contextualDecisionContract(events, "bot", snapshot.targetMessageId, snapshot);
    const raw = contextualProposal({ relationship: "group", linkKey: "reaction", recipientEvidence: [] });
    expect(new Ajv().compile(contract.schema)(raw)).toBe(true);
    expect(contract.parse(raw)).toMatchObject({ target: "confirmed-reply", contribution: { recipientId: "group" },
      contextual: { link: { kind: "reaction", actorIds: ["alice"] } } });
    expect(() => contract.parse({ ...raw, targetKey: "candidate_1" })).toThrow();
    expect(() => contract.parse({ ...raw, linkKey: "speaker_1" })).toThrow();
  });
  it("requires the same referent enum in the advertised and local contract", () => {
    const contract = contextualDecisionContract(events, "bot", "current");
    const validate = new Ajv().compile(contract.schema);
    for (const referent of [undefined, "invented", 5]) {
      const raw = contextualProposal({ referent });
      expect(validate(raw)).toBe(false);
      expect(() => contract.parse(raw)).toThrow();
    }
    expect(contract.parse(contextualProposal({ referent: "unresolved", action: "silent", contribution: null, recipientEvidence: [] })))
      .toMatchObject({ contextual: { referent: "unresolved", action: "silent" } });
  });
  it("maps short evidence keys back to authorized numeric source IDs", () => {
    const ids = new Map(events.map((event, index) => [event.messageId, `100000000000000000${index}`]));
    const numericEvents = events.map((event) => ({ ...event, messageId: ids.get(event.messageId)!,
      ...(event.replyToMessageId ? { replyToMessageId: ids.get(event.replyToMessageId)! } : {}) }));
    const contract = contextualDecisionContract(numericEvents, "bot", numericEvents.at(-1)!.messageId);
    expect(new Set(contract.parse(contextualProposal({ recipientEvidence: ["event_1", "event_3"] })).recipientEvidence)).toEqual(new Set(numericEvents.map((event) => event.messageId)));
    expect(() => contract.parse(contextualProposal({ recipientEvidence: ["private_event"] }))).toThrow();
  });
  it("owns the current destination and recipient with no corresponding wire fields", () => {
    const contract = contextualDecisionContract(events, "bot", "current");
    expect(new Ajv().compile(contract.schema)(contextualProposal())).toBe(true);
    expect(contract.parse(contextualProposal())).toMatchObject({ target: "current", contribution: { sourceMessageId: "current", recipientId: "alice" } });
    for (const key of ["target", "targetKey", "boundary", "recipientId"]) expect(() => contract.parse(contextualProposal({ [key]: "invented" }))).toThrow();
  });
  it("accepts abstention without a target or fake contribution", () => {
    const contract = contextualDecisionContract(events, "bot", null);
    expect(contract.parse(contextualProposal({ action: "silent", targetKey: null, contribution: null, recipientEvidence: [] }))).toMatchObject({ contextual: { action: "silent" }, target: "" });
  });
  it("offers only unanswered human candidate keys and rejects arbitrary IDs", () => {
    const contract = contextualDecisionContract(events, "bot", null);
    expect(contract.targets).toEqual([{ key: "candidate_1", eventId: "current" }]);
    expect(contract.parse(contextualProposal({ targetKey: "candidate_1" })).target).toBe("current");
    for (const key of ["original", "confirmed-reply", "alice", "missing", null]) expect(() => contract.parse(contextualProposal({ targetKey: key }))).toThrow();
  });
  it("rejects missing or private evidence and a non-human fixed binding", () => {
    expect(() => contextualDecisionContract(events, "bot", "current").parse(contextualProposal({ recipientEvidence: ["private"] }))).toThrow();
    expect(() => contextualDecisionContract(events, "bot", "confirmed-reply").parse(contextualProposal())).toThrow();
  });
  it("recovers a failed primary through the new fallback contract", async () => {
    const primary = { generateCharacterData: vi.fn(() => Promise.reject(new Error("failed"))) };
    const fallback = { generateCharacterData: vi.fn(() => Promise.resolve(contextualProposal())) };
    const result = await new CharacterDecisionService(primary, fallback).evaluate({ contextual: true, personality: "synthetic", events,
      burst: [branchCurrent], botId: "bot", fixedTarget: "current", gapMs: 1000, speakingShare: 0, thoughts: false, useContextBoundary: false });
    expect(result).toMatchObject({ status: "valid", decision: { target: "current" }, attempts: [{ status: "failed" }, { status: "valid", contractVersion: "contextual_v1", targetMode: "fixed" }] });
  });
});
