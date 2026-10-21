import type { ChatProvider, ChatRequest, UserCustomizationAnalysisResult } from "../chat/chat-provider.js";
import { isEvaluationContext, type GuardedEvaluationContext } from "./guarded-evaluation-context.js";
import { immutableSnapshot } from "./immutable-snapshot.js";
import { deriveStyleProfile, trimVoice, voiceViolations } from "../chat/character-voice.js";
import { characterInactiveReason } from "../chat/character-settings.js";
import { serious, truthfulQuestion } from "../chat/character-modules/shared.js";
import type { EmbeddingsClient } from "../chat/embeddings-client.js";
import { embedTextsBestEffort } from "../chat/embedding-batch.js";
import { personaEmbeddingSources } from "../chat/persona-bundle-compilation.js";
import { personaLoreEmbeddingText } from "../chat/persona-bundle.js";
import { parseExampleExchanges } from "../chat/example-exchange.js";
import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import { isConfigurationContext, type GuardedConfigurationContext } from "./guarded-configuration-context.js";
import { approveModelOperation, approveEmbeddingOperation } from "./approved-model-operation.js";
import { approveEvaluationRequest } from "./approved-conversation-request.js";

// Closed configuration operations own input projection. Consumers cannot add
// participant text through an arbitrary prompt or embedding override.
export class ConfigurationModelGateway {
  public constructor(private readonly provider: ChatProvider | null, private readonly embeddings: EmbeddingsClient | null = null) {}
  public get canCompile(): boolean { return !!this.provider?.compilePersonaBundle; }
  public get canAnalyze(): boolean { return !!this.provider?.analyzeUserCustomization; }
  public get embeddingModelId(): string | null { return this.embeddings?.modelId ?? null; }
  public async probe(context: GuardedEvaluationContext, candidate = true, active: () => boolean = () => true): Promise<string> {
    if (!isEvaluationContext(context) || !this.provider) throw new SocialOutputSuppressed();
    const check = async (): Promise<void> => { if (!active()) throw new SocialOutputSuppressed(); await context.check(); if (!active()) throw new SocialOutputSuppressed(); };
    await check();
    const material = context.persona.material;
    const controls = context.settings;
    const request: ChatRequest = approveEvaluationRequest(context, { ...immutableSnapshot({
      guildId: context.scope.guildId, channelId: context.scope.channelId, personality: material.text,
      characterEvaluation: true, personaLore: (material.loreChunks ?? []).map(({ heading, text }) => ({ heading, text })),
      exampleExchanges: (material.examples ?? []).slice(0, 4).map(({ tags, user, character }) => ({ tags, user, character })),
      personaDrift: null, userCustomization: null, currentUser: { id: "synthetic-reviewer", displayName: "Reviewer", roleNames: [] },
      mentionedUsers: [], recentHistory: [], memories: [], guildKnowledge: [], causalChains: [], message: context.question,
      replyChain: [], replyChainSummary: null, channelHistory: [], birthday: null, images: [], enabledTools: [],
      webSearchMode: "off" as const, imageGenerationEnabled: false, includeSources: false, triggerMode: "direct" as const,
      characterContext: candidate ? [{ moduleId: "synthetic-evaluation", text:
        "Answer this hypothetical character interview using authored persona configuration only. No participant history, memories or learned state is available. Do not invent remembered interactions. Answer explicit questions normally, keep acknowledgments brief, and do not prolong a closing with generic help." }] : [],
    }), beforeModelAttempt: check });
    let response = await this.provider.reply(request); await check();
    const voice = !characterInactiveReason(controls, "voice", context.scope.channelId,
      { context: false, decision: false, memorySharing: false, continuation: false, spontaneous: false, excluded: false });
    if (candidate && voice && !serious(context.question) && !truthfulQuestion(context.question)) {
      const text = trimVoice(response.text) || response.text;
      const substantive = context.question.length > 100 || /explain|how to|解釋|說明|教我|説明/iu.test(context.question);
      const flags = voiceViolations(text, deriveStyleProfile(request.exampleExchanges), substantive);
      if (controls.modules.voice.strictness === "regenerate" && (flags.includes("markdown") || flags.includes("length"))) {
        response = await this.provider.reply(approveEvaluationRequest(context, { ...request, attributionRepair: Object.freeze({ draft: text,
          notes: "Repair only casual voice/formatting. Match the authored examples, preserve factual content and truthful bot disclosures." }) }));
        await check(); return response.text.trim() || text;
      }
      return text;
    }
    return response.text;
  }
  public async compile(context: GuardedConfigurationContext): Promise<readonly number[]> {
    if (!isConfigurationContext(context, "persona_upload") || !this.provider?.compilePersonaBundle) throw new SocialOutputSuppressed();
    await context.check();
    const result = await this.provider.compilePersonaBundle(context.material.text, approveModelOperation(context, "compilePersonaBundle", [context.material.text], context.modelOptions("persona_compile")));
    await context.check(); return result;
  }
  public async analyze(context: GuardedConfigurationContext): Promise<UserCustomizationAnalysisResult> {
    if (!isConfigurationContext(context, "user_preferences") || !this.provider?.analyzeUserCustomization) throw new SocialOutputSuppressed();
    await context.check();
    const result = await this.provider.analyzeUserCustomization(context.material.text, approveModelOperation(context, "analyzeUserCustomization", [context.material.text], context.modelOptions("preferences_analysis")));
    await context.check(); return result;
  }
  public async embedConfiguration(context: GuardedConfigurationContext, keys: readonly string[]): Promise<(number[] | null)[]> {
    if (!isConfigurationContext(context) || !this.embeddings || keys.length > 512) throw new SocialOutputSuppressed();
    await context.check(); let admitted: Set<string>;
    if (context.scope.kind === "persona_upload") admitted = new Set(personaEmbeddingSources(context.material.text).map(personaLoreEmbeddingText));
    else if (context.scope.kind === "examples_upload") {
      const parsed = parseExampleExchanges(context.material.text); if ("error" in parsed) throw new SocialOutputSuppressed();
      admitted = new Set(parsed.exchanges.map((exchange) => `${exchange.tags}\n${exchange.user}`));
    } else throw new SocialOutputSuppressed();
    if (keys.some((key) => !admitted.has(key))) throw new SocialOutputSuppressed();
    const result = await embedTextsBestEffort(keys, this.embeddings, approveEmbeddingOperation(context, keys, context.modelOptions("configuration_embedding")));
    await context.check(); return result;
  }
}
