import { describe, expect, it, vi } from "vitest";
import { CharacterDecisionService, decisionJsonSchema, decisionSchema, type CharacterDecision } from "../../src/application/chat/character-decision.js";
import Ajv from "ajv";
import { emitChatDiagnostic } from "../../src/application/diagnostics/chat-diagnostics.js";
import { ChatProviderError } from "../../src/application/chat/chat-provider.js";

const contribution = { text: "SECRET_CANDIDATE", adds: "Specific answer", label: "answer" as const,
  motivation: 0.9, sourceMessageId: "current", recipientId: "alice" };
const decision: CharacterDecision = { addressing: "bot", motivation: 0.9, recipientEvidence: ["current"], recipientConfidence: 0.9,
  targetConfidence: 0.9, contribution, opening: "clear", boundary: "earlier", target: "current", confidence: 0.9, reaction: null, thoughts: [] };
const input = { personality: "SECRET_PERSONA", events: [], burst: [{ messageId: "current", authorId: "alice", authorDisplayName: "SECRET_NAME",
  content: "SECRET_MESSAGE", timestampMs: 100, imageCount: 0 }], botId: "bot", fixedTarget: null, gapMs: 1000, speakingShare: 0, thoughts: false };

describe("decision attempt diagnostics", () => {
  it.each([
    decision,
    { ...decision, contribution: { ...contribution, text: "😀".repeat(200) } },
    { ...decision, contribution: { ...contribution, text: "😀".repeat(201) } },
    { ...decision, contribution: { ...contribution, text: "x".repeat(201) } },
    { ...decision, contribution: { ...contribution, adds: "x".repeat(201) } },
    { ...decision, recipientEvidence: [] },
    { ...decision, recipientEvidence: Array(9).fill("current") },
    { ...decision, confidence: 1.1 },
    { ...decision, recipientConfidence: -1 },
    { ...decision, thoughts: Array(4).fill(contribution) },
    { ...decision, unexpected: "SECRET" },
  ])("keeps advertised and local schema acceptance aligned %#", (output) => {
    const validate = new Ajv().compile(decisionJsonSchema);
    expect(validate(output)).toBe(decisionSchema.safeParse(output).success);
  });
  it("reports bounded field codes without rejected values or unknown keys", async () => {
    const output = { ...decision, contribution: { ...contribution, text: "SECRET".repeat(50), SECRET_KEY: "SECRET_VALUE" }, recipientConfidence: 9 };
    const result = await new CharacterDecisionService({ generateCharacterData: (): Promise<unknown> => Promise.resolve(output) }).evaluate(input);
    expect(result.attempts[0]?.validationIssues).toEqual(expect.arrayContaining([
      { field: "contribution.text", code: "too_big" }, { field: "contribution", code: "unrecognized_keys" },
      { field: "recipientConfidence", code: "too_big" },
    ]));
    expect(JSON.stringify(result.attempts)).not.toContain("SECRET");
    const logger = { info: vi.fn(), warn: vi.fn() };
    emitChatDiagnostic(logger, { event: "model.decision.attempt", ...result.attempts[0]! });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ validationIssues: result.attempts[0]!.validationIssues, stage: "model", timeoutMs: 6000 }), "model.decision.attempt");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("SECRET");
  });
  it("retains a failed primary attempt when a fallback succeeds, without recording content", async () => {
    const primary = { generateCharacterData: (): Promise<unknown> => Promise.reject(new ChatProviderError("SECRET_ERROR", 429, "SECRET_CODE")) };
    const fallback = { generateCharacterData: (): Promise<unknown> => Promise.resolve(decision) };
    const observed = vi.fn();
    const outcome = await new CharacterDecisionService(primary, fallback, observed).evaluate(input);
    expect(outcome.status).toBe("valid");
    expect(outcome.attempts).toEqual([
      expect.objectContaining({ providerRole: "primary", attempt: 1, status: "failed", failure: "rate_limited", httpStatus: 429 }),
      expect.objectContaining({ providerRole: "fallback", attempt: 2, status: "valid" }),
    ]);
    expect(observed).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(outcome.attempts)).not.toContain("SECRET");
  });

  it.each([
    ["invalid_target", { ...decision, target: "missing" }],
    ["invalid_boundary", { ...decision, boundary: "missing" }],
    ["invalid_evidence", { ...decision, recipientEvidence: ["missing"] }],
    ["invalid_contribution", { ...decision, contribution: { ...contribution, sourceMessageId: "missing" } }],
    ["recipient_mismatch", { ...decision, contribution: { ...contribution, recipientId: "bob" } }],
    ["schema_mismatch", { text: "SECRET_INVALID_RESPONSE" }],
  ])("distinguishes rejected output: %s", async (failure, output) => {
    // Bob is an eligible supplied human so a wrong recipient is distinct from
    // an invented candidate ID rejected earlier in grounding validation.
    const events = [{ ...input.burst[0]!, messageId: "other", authorId: "bob", timestampMs: 50 }];
    const outcome = await new CharacterDecisionService({ generateCharacterData: (): Promise<unknown> => Promise.resolve(output) }).evaluate({ ...input, events });
    expect(outcome).toMatchObject({ status: "failed", decision: null, attempts: [{ failure }] });
    expect(JSON.stringify(outcome.attempts)).not.toContain("SECRET");
  });

  it("keeps timeout and invalid JSON separate and does not duplicate a shared fallback", async () => {
    for (const [error, failure] of [[new DOMException("SECRET", "TimeoutError"), "timeout"], [new SyntaxError("SECRET"), "invalid_json"]] as const) {
      const provider = { generateCharacterData: vi.fn(() => Promise.reject(error)) };
      const outcome = await new CharacterDecisionService(provider, provider).evaluate(input);
      expect(outcome.attempts).toHaveLength(1);
      expect(outcome.attempts[0]?.failure).toBe(failure);
      expect(provider.generateCharacterData).toHaveBeenCalledOnce();
    }
  });

  it("does not let diagnostic callbacks reject an otherwise valid decision", async () => {
    const result = await new CharacterDecisionService({ generateCharacterData: (): Promise<unknown> => Promise.resolve(decision) }, null,
      () => { throw new Error("sink failed"); }).evaluate(input);
    expect(result.status).toBe("valid");
  });
});
