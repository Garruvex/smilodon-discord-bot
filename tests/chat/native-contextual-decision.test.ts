import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterDecisionService, optionalParticipationRejection } from "../../src/application/chat/character-decision.js";
import { contextualReplayCases } from "../../src/application/chat/contextual-replay.js";
import { contextualDecisionProviders } from "../../src/application/chat/contextual-decision-providers.js";
import { syntheticReplayContext } from "../../src/application/chat/synthetic-replay-context.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { approveDecisionInput } from "../../src/application/context/approved-decision-input.js";
import { guardModelTransport } from "../../src/application/context/guarded-model-transport.js";
import { OpenAiNativeDecisionProvider } from "../../src/infrastructure/chat/openai-native-decision-provider.js";
import { nativeDecisionBody, nativeQuestionSchema } from "../helpers/native-decision-fixtures.js";
import { z } from "zod";
import { replayPolicyAssessment } from "../../src/application/chat/contextual-replay-policy.js";
import { contextualDecisionContract } from "../../src/application/chat/contextual-decision-contract.js";
import { nativeContextualDecisionContract } from "../../src/application/chat/native-contextual-decision.js";
import { branchHuman, branchBot, branchCurrent } from "../helpers/conversation-decision-fixtures.js";

afterEach(() => vi.unstubAllGlobals());
describe("native contextual decisions through authorized source transport", () => {
  const fixture = contextualReplayCases().find((item) => item.id === "en-answer-3000-same")!;
  const provider = (): ReturnType<typeof guardModelTransport<OpenAiNativeDecisionProvider>> => guardModelTransport(new OpenAiNativeDecisionProvider({
    model: "gpt-6-luna", baseUrl: "https://api.openai.com/v1", apiKey: "synthetic-key" }));
  async function input(): Promise<Parameters<CharacterDecisionService["evaluate"]>[0]> {
    const { port, botId } = await syntheticReplayContext(fixture);
    const lease = await GuardedConversationContext.open(port, { count: 40, budget: 12000, burstIds: [fixture.current.messageId] });
    return approveDecisionInput({ sourceContext: lease, contextual: true, personality: "Synthetic", events: lease.history,
      burst: lease.burst, botId, fixedTarget: lease.current.messageId, gapMs: 60000, speakingShare: 0, thoughts: false, canUseContext: () => lease.validate() });
  }
  it("uses native choices for admission and defers reply prose without fabricated speech", async () => {
    const fetcher = vi.fn<typeof fetch>((_url, request) => {
      const parsed = z.object({ questions: z.array(nativeQuestionSchema) }).parse(JSON.parse(request!.body as string) as unknown);
      expect(parsed.questions.map((question) => question.name)).not.toContain("targetKey");
      expect(parsed.questions.map((question) => question.name)).not.toContain("linkKey");
      return Promise.resolve(Response.json(nativeDecisionBody(parsed.questions)));
    }); vi.stubGlobal("fetch", fetcher);
    const reply = { generateCharacterData: vi.fn() };
    const native = provider(); expect(native.decisionProtocol).toBe("openai-decisions");
    const selection = contextualDecisionProviders(native, reply, null);
    expect(selection.fallback).toBeNull();
    const service = new CharacterDecisionService(null, null, null, selection);
    const result = await service.evaluate(await input());
    expect(result.status, JSON.stringify(result.attempts)).toBe("valid");
    expect(result.decision).toMatchObject({ contextual: { relationship: "followup", action: "reply" }, nativeContributionPlan: { addsValue: true }, contribution: { text: "", adds: "", label: "answer" } });
    expect(result.decision?.nativeConfidence).toEqual({ relationship: 0.99, link: 1, evidenceSelection: 0.99, target: 1, action: 0.99, referent: 0.99 });
    expect(optionalParticipationRejection("continuation", "continuing", result.decision, false)).toBeNull();
    expect(optionalParticipationRejection("continuation", "continuing", { ...result.decision!, nativeContributionPlan: { addsValue: false } }, false)).toBe("contribution_empty");
    expect(await replayPolicyAssessment(fixture, result)).toMatchObject({ action: "reply", requiredReplyMet: true });
    expect(reply.generateCharacterData).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not silently retry a refused native decision through the reasoning reply model", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("Synthetic failure", { status: 503 })));
    const reply = { generateCharacterData: vi.fn() };
    const service = new CharacterDecisionService(null, null, null, contextualDecisionProviders(provider(), reply, null));
    expect((await service.evaluate(await input())).status).toBe("failed"); expect(reply.generateCharacterData).not.toHaveBeenCalled();
  });
  it("rejects unapproved calls to the guarded native provider before HTTP", async () => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
    await expect(provider().generateCharacterData("Unapproved", {})).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("probes native contextual capability rather than sending a legacy text-generation schema", async () => {
    const fetcher = vi.fn<typeof fetch>((_url, request) => {
      const parsed = z.object({ questions: z.array(nativeQuestionSchema) }).parse(JSON.parse(request!.body as string) as unknown);
      return Promise.resolve(Response.json(nativeDecisionBody(parsed.questions, { relationship: "group", referent: "self_contained" })));
    }); vi.stubGlobal("fetch", fetcher);
    const service = new CharacterDecisionService(null, null, null, contextualDecisionProviders(provider(), null, null));
    const health = await service.checkHealth(); expect(health.configured).toBe(true); expect(health.lastSuccessAt).not.toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("native binding and confidence regressions", () => {
  const provider = (): OpenAiNativeDecisionProvider => new OpenAiNativeDecisionProvider({
    model: "gpt-6-luna", baseUrl: "https://api.openai.com/v1", apiKey: "synthetic-key" });
  const events = [branchHuman, branchBot, branchCurrent];
  it.each([0.99, 0.6])("keeps recipient confidence %s independent of optional evidence votes and fixed target", async (recipient) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((_url, request) => {
      const { questions } = z.object({ questions: z.array(nativeQuestionSchema) }).parse(JSON.parse(request!.body as string) as unknown);
      const body = nativeDecisionBody(questions);
      body.answers = body.answers.map((raw) => {
        const answer = z.object({ name: z.string(), choice: z.union([z.boolean(), z.string()]), probabilities: z.array(z.object({ value: z.union([z.boolean(), z.string()]), probability: z.number() })) }).passthrough().safeParse(raw);
        if (!answer.success) return raw;
        const confidence = answer.data.name.startsWith("evidence_") ? 0.55 : answer.data.name === "relationship" ? recipient : 0.99;
        return { ...answer.data, confidence, probabilities: answer.data.probabilities.map((item) => ({ ...item,
          probability: item.value === answer.data.choice ? confidence : (1 - confidence) / (answer.data.probabilities.length - 1) })) };
      });
      return Promise.resolve(Response.json(body));
    }));
    const contract = nativeContextualDecisionContract(contextualDecisionContract(events, "bot", "current"), "current");
    const decision = contract.parse(await provider().generateCharacterData("Synthetic conversation", contract.schema));
    expect(decision).toMatchObject({ target: "current", targetConfidence: 1, recipientConfidence: recipient, confidence: recipient,
      nativeConfidence: { evidenceSelection: 0.55, link: 1, target: 1 } });
    expect(decision.recipientEvidence).toEqual(expect.arrayContaining(["original", "confirmed-reply", "current"]));
    expect(optionalParticipationRejection("continuation", "continuing", decision, false)).toBe(recipient < 0.7 ? "recipient_confidence_low" : null);
  });
  it("selects among multiple supplied exchanges only after classifying the recipient, and accounts for both calls", async () => {
    const earlier = { ...branchHuman, messageId: "earlier", timestampMs: branchHuman.timestampMs - 2000 };
    const earlierBot = { ...branchBot, messageId: "earlier-bot", replyToMessageId: "earlier", timestampMs: branchHuman.timestampMs - 1000 };
    const contract = nativeContextualDecisionContract(contextualDecisionContract([earlier, earlierBot, ...events], "bot", "current"), "current");
    const fetcher = vi.fn<typeof fetch>((_url, request) => {
      const { questions } = z.object({ questions: z.array(nativeQuestionSchema) }).parse(JSON.parse(request!.body as string) as unknown);
      if (questions.length === 1) {
        expect(questions[0]).toMatchObject({ name: "linkKey", choices: [{ value: "speaker_1" }, { value: "speaker_2" }] });
        expect(request!.body).toContain("confirmed-reply");
      } else expect(questions.map((question) => question.name)).not.toContain("linkKey");
      return Promise.resolve(Response.json(nativeDecisionBody(questions, { linkKey: "speaker_2" })));
    });
    vi.stubGlobal("fetch", fetcher);
    const onUsage = vi.fn();
    const decision = contract.parse(await provider().generateCharacterData("Synthetic conversation", contract.schema, { onUsage }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenLastCalledWith({ inputTokens: 200, outputTokens: 0, totalTokens: 200, cachedInputTokens: 40, reasoningTokens: 0 });
    expect(decision.contextual?.link).toMatchObject({ humanEventId: "original", botEventId: "confirmed-reply" });
  });
  it("does not invent an exchange when none was supplied", async () => {
    const contract = nativeContextualDecisionContract(contextualDecisionContract([branchCurrent], "bot", "current"), "current");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((_url, request) => {
      const { questions } = z.object({ questions: z.array(nativeQuestionSchema) }).parse(JSON.parse(request!.body as string) as unknown);
      return Promise.resolve(Response.json(nativeDecisionBody(questions)));
    }));
    const raw = await provider().generateCharacterData("Synthetic conversation", contract.schema);
    expect(() => contract.parse(raw)).toThrow("Invalid contextual decision");
  });
  it.each(["reply", "silent"])("binds selectable destinations after action %s without an independent none vote", async (action) => {
    const another = { ...branchCurrent, messageId: "another", timestampMs: branchCurrent.timestampMs + 1 };
    const contract = nativeContextualDecisionContract(contextualDecisionContract([...events, another], "bot", null), null);
    const fetcher = vi.fn<typeof fetch>((_url, request) => {
      const { questions } = z.object({ questions: z.array(nativeQuestionSchema) }).parse(JSON.parse(request!.body as string) as unknown);
      if (questions.length === 1) expect(questions[0]).toMatchObject({ name: "targetKey", choices: [{ value: "candidate_1" }, { value: "candidate_2" }] });
      else expect(questions.map((question) => question.name)).not.toContain("targetKey");
      return Promise.resolve(Response.json(nativeDecisionBody(questions, { action, targetKey: "candidate_2" })));
    });
    vi.stubGlobal("fetch", fetcher);
    const decision = contract.parse(await provider().generateCharacterData("Synthetic conversation", contract.schema));
    expect(decision.target).toBe(action === "reply" ? "another" : "");
    expect(fetcher).toHaveBeenCalledTimes(action === "reply" ? 2 : 1);
  });
});
