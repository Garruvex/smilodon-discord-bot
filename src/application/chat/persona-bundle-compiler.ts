import type { Logger } from "pino";

import { hashContent } from "../assets/content-hash.js";
import type { ChatProvider } from "./chat-provider.js";
import type { PersonaBundle } from "./persona-bundle.js";
import type { EmbeddingsClient } from "../../infrastructure/chat/openai-embeddings-client.js";

/**
 * Compiles an uploaded personality.md into a PersonaBundle: an always-sent
 * "core" plus retrievable, embedded lore chunks — see
 * ChatProvider.compilePersonaBundle and persona-lore-selector.ts. Runs once
 * at upload time (GuildAssetStore.savePersonality), never per turn.
 *
 * Every failure mode (no provider support, LLM error, embeddings
 * unavailable) resolves to `null` rather than throwing — an upload must
 * never fail because compilation failed, it just doesn't get the retrieval
 * optimization this turn. FilePersonaSource falls back to sending the whole
 * file when no bundle is present.
 */
export class PersonaBundleCompiler {
  public constructor(
    private readonly provider: ChatProvider,
    private readonly embeddingsClient: EmbeddingsClient | null,
    private readonly logger: Logger | null = null,
  ) {}

  public async compile(content: string): Promise<PersonaBundle | null> {
    if (!this.provider.compilePersonaBundle) return null;
    try {
      const result = await this.provider.compilePersonaBundle(content);
      const chunks = await Promise.all(result.chunks.map(async (chunk) => ({
        heading: chunk.heading,
        text: chunk.text,
        embedding: await this.embedChunk(chunk.text),
      })));
      return {
        sourceHash: hashContent(content),
        core: result.core,
        chunks,
        compiledAt: Date.now(),
      };
    } catch (error) {
      this.logger?.warn({ error }, "Personality bundle compilation failed; the full file will be sent as-is");
      return null;
    }
  }

  private async embedChunk(text: string): Promise<number[] | null> {
    if (!this.embeddingsClient) return null;
    try {
      return await this.embeddingsClient.embed(text);
    } catch (error) {
      this.logger?.warn({ error }, "Embedding a persona lore chunk failed; it will only be retrievable lexically");
      return null;
    }
  }
}
