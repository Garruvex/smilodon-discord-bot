import type { ChatProvider, UserCustomizationAnalysisResult } from "../chat/chat-provider.js";
import type { EmbeddingsClient } from "../chat/embeddings-client.js";
import { embedTextsBestEffort } from "../chat/embedding-batch.js";
import { personaEmbeddingSources } from "../chat/persona-bundle-compilation.js";
import { personaLoreEmbeddingText } from "../chat/persona-bundle.js";
import { parseExampleExchanges } from "../chat/example-exchange.js";
import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import { isConfigurationContext, type GuardedConfigurationContext } from "./guarded-configuration-context.js";

// Closed configuration operations own input projection. Consumers cannot add
// participant text through an arbitrary prompt or embedding override.
export class ConfigurationModelGateway {
  public constructor(private readonly provider: ChatProvider | null, private readonly embeddings: EmbeddingsClient | null = null) {}
  public get canCompile(): boolean { return !!this.provider?.compilePersonaBundle; }
  public get canAnalyze(): boolean { return !!this.provider?.analyzeUserCustomization; }
  public get embeddingModelId(): string | null { return this.embeddings?.modelId ?? null; }
  public async compile(context: GuardedConfigurationContext): Promise<readonly number[]> {
    if (!isConfigurationContext(context, "persona_upload") || !this.provider?.compilePersonaBundle) throw new SocialOutputSuppressed();
    await context.check();
    const result = await this.provider.compilePersonaBundle(context.material.text, context.modelOptions("persona_compile"));
    await context.check(); return result;
  }
  public async analyze(context: GuardedConfigurationContext): Promise<UserCustomizationAnalysisResult> {
    if (!isConfigurationContext(context, "user_preferences") || !this.provider?.analyzeUserCustomization) throw new SocialOutputSuppressed();
    await context.check();
    const result = await this.provider.analyzeUserCustomization(context.material.text, context.modelOptions("preferences_analysis"));
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
    const result = await embedTextsBestEffort(keys, this.embeddings, context.modelOptions("configuration_embedding"));
    await context.check(); return result;
  }
}
