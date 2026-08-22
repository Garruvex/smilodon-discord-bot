import type { Logger } from "pino";

import { hashContent } from "../assets/content-hash.js";
import type { ChatProvider } from "./chat-provider.js";
import type { PersonaBundle } from "./persona-bundle.js";
import { assemblePersonaBundle } from "../../infrastructure/chat/persona-bundle-compilation.js";
import type { EmbeddingsClient } from "../../infrastructure/chat/openai-embeddings-client.js";
import { embedTextsBestEffort } from "./embedding-batch.js";

// Independent classification samples per upload (self-consistency) — a
// section is only treated as lore if a majority of samples agree, so one
// unstable/borderline classification can't move a core-identity section
// out of the always-sent block on its own. Compile-time only (never per
// turn), so tripling the classification call count is still cheap.
const classificationSampleCount = 3;
const classificationMajorityThreshold = Math.floor(classificationSampleCount / 2) + 1;

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

  // `previousBundle` (the guild's last compiled bundle, if any) lets a
  // reupload reuse embeddings for chunks whose text didn't change — most
  // edits only touch one section, so re-embedding every chunk from scratch
  // every time is pure waste. Purely a cost optimization: a miss (no
  // previous bundle, or every chunk's text changed) just re-embeds
  // everything, same as before this existed.
  public async compile(content: string, previousBundle: PersonaBundle | null = null): Promise<PersonaBundle | null> {
    if (!this.provider.compilePersonaBundle) return null;
    try {
      const samples = await Promise.all(
        Array.from({ length: classificationSampleCount }, () => this.provider.compilePersonaBundle!(content)),
      );
      const votes = new Map<number, number>();
      for (const sample of samples) {
        for (const index of sample) votes.set(index, (votes.get(index) ?? 0) + 1);
      }
      const loreIndexes = new Set(
        [...votes.entries()].filter(([, count]) => count >= classificationMajorityThreshold).map(([index]) => index),
      );
      const result = assemblePersonaBundle(content, loreIndexes);

      const previousEmbeddingByText = new Map(
        (previousBundle?.chunks ?? [])
          .filter((chunk) => chunk.embedding !== null)
          .map((chunk) => [chunk.text, chunk.embedding] as const),
      );
      const textsNeedingEmbedding = result.chunks
        .map((chunk) => chunk.text)
        .filter((text) => !previousEmbeddingByText.has(text));
      const freshEmbeddings = this.embeddingsClient && textsNeedingEmbedding.length > 0
        ? await embedTextsBestEffort(textsNeedingEmbedding, this.embeddingsClient)
        : [];
      const freshEmbeddingByText = new Map(textsNeedingEmbedding.map((text, index) => [text, freshEmbeddings[index] ?? null]));

      const failedEmbeddingCount = [...freshEmbeddingByText.values()].filter((embedding) => embedding === null).length;
      if (this.embeddingsClient && failedEmbeddingCount > 0) {
        this.logger?.warn(
          { failedEmbeddingCount, chunkCount: result.chunks.length },
          "Embedding persona lore chunks partially failed; those chunks will be retrievable lexically",
        );
      }
      const chunks = result.chunks.map((chunk) => ({
        heading: chunk.heading,
        text: chunk.text,
        embedding: previousEmbeddingByText.get(chunk.text) ?? freshEmbeddingByText.get(chunk.text) ?? null,
      }));
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

}
