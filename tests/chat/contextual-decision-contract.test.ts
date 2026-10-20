import { describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
import { contextualDecisionContract } from "../../src/application/chat/contextual-decision-contract.js";
import { CharacterDecisionService } from "../../src/application/chat/character-decision.js";
import { branchHuman, branchBot, branchCurrent } from "../helpers/conversation-decision-fixtures.js";

export function contextualProposal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { relationship: "followup", intent: "answer", action: "reply", recipientEvidence: ["current"], recipientConfidence: 0.95,
    confidence: 0.95, opening: "clear", contribution: { text: "A specific answer", adds: "New information", label: "answer", motivation: 0.95 }, reaction: null, ...extra };
}
const events = [branchHuman, branchBot, branchCurrent];
describe("contextual decision binding", () => {
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
