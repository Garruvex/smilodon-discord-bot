import { describe, expect, it, vi } from "vitest";
import { contextualDecisionProviders } from "../../src/application/chat/contextual-decision-providers.js";
import { CharacterDecisionService } from "../../src/application/chat/character-decision.js";
import { contextualProposal } from "../helpers/contextual-decision-fixtures.js";
import { decisionProposal, branchHuman, branchBot, branchCurrent } from "../helpers/conversation-decision-fixtures.js";
import type { StructuredCharacterProvider } from "../../src/application/chat/chat-provider.js";

describe("contextual provider routing shared by runtime and replay", () => {
  const provider = (): { generateCharacterData: ReturnType<typeof vi.fn<StructuredCharacterProvider["generateCharacterData"]>> } => ({
    generateCharacterData: vi.fn<StructuredCharacterProvider["generateCharacterData"]>(() => Promise.resolve(contextualProposal())),
  });
  const input = { personality: "Synthetic", events: [branchHuman, branchBot], burst: [branchCurrent], botId: "bot", fixedTarget: "current", gapMs: 1000, speakingShare: 0, thoughts: false };
  it("uses reply capability for contextual interpretation while preserving legacy utility selection", async () => {
    const utility = provider(); const reply = provider(); utility.generateCharacterData.mockResolvedValue(decisionProposal());
    const selected = contextualDecisionProviders(null, reply, utility);
    expect(selected).toEqual({ primary: reply, fallback: null, source: "reply" });
    const service = new CharacterDecisionService(utility, null, null, selected);
    expect((await service.evaluate({ ...input, contextual: true })).status).toBe("valid");
    expect(reply.generateCharacterData).toHaveBeenCalledOnce(); expect(utility.generateCharacterData).not.toHaveBeenCalled();
    expect((await service.evaluate(input)).status).toBe("valid"); expect(utility.generateCharacterData).toHaveBeenCalledOnce();
  });
  it("respects a dedicated model and bounds a fallback to the reply capability", async () => {
    const dedicated = provider(); dedicated.generateCharacterData.mockRejectedValue(new Error("Synthetic transport failure"));
    const reply = provider(); const utility = provider();
    const selected = contextualDecisionProviders(dedicated, reply, utility);
    const service = new CharacterDecisionService(dedicated, utility, null, selected);
    const result = await service.evaluate({ ...input, contextual: true });
    expect(result.status).toBe("valid"); expect(result.attempts.map((attempt) => attempt.providerRole)).toEqual(["primary", "fallback"]);
    expect(reply.generateCharacterData).toHaveBeenCalledOnce(); expect(utility.generateCharacterData).not.toHaveBeenCalled();
  });
  it("does not silently downgrade to generic utility after the reply model fails", async () => {
    const reply = provider(); reply.generateCharacterData.mockRejectedValue(new Error("Unavailable")); const utility = provider();
    const service = new CharacterDecisionService(utility, utility, null, contextualDecisionProviders(null, reply, utility));
    expect((await service.evaluate({ ...input, contextual: true })).status).toBe("failed"); expect(utility.generateCharacterData).not.toHaveBeenCalled();
  });
  it("labels missing reply capability and absent providers explicitly", () => {
    const utility = provider(); expect(contextualDecisionProviders(null, null, utility)).toEqual({ primary: utility, fallback: null, source: "utility" });
    expect(contextualDecisionProviders(null, null, null)).toEqual({ primary: null, fallback: null, source: "unavailable" });
  });
});
