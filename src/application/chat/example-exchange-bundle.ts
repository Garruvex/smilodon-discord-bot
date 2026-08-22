import { z } from "zod";

import { hashContent } from "../assets/content-hash.js";
import type { ExampleExchange } from "./example-exchange.js";
import type { EmbeddingsClient } from "../../infrastructure/chat/openai-embeddings-client.js";
import { embedTextsBestEffort } from "./embedding-batch.js";

// Sidecar JSON written next to an uploaded examples.md
// (guild-assets/{guildId}/examples.bundle.json), self-contained (not
// index-matched against the .md) so a `sourceHash` mismatch is the only
// staleness check needed — same convention as personality.bundle.json.
export const exampleExchangeBundleSchema = z.object({
  sourceHash: z.string(),
  exchanges: z.array(z.object({
    tags: z.string(),
    user: z.string(),
    character: z.string(),
    embedding: z.array(z.number()).nullable(),
  })),
});

export type ExampleExchangeBundle = z.infer<typeof exampleExchangeBundleSchema>;

export function serializeExampleExchangeBundle(bundle: ExampleExchangeBundle): string {
  return JSON.stringify(bundle);
}

/** Returns null for missing/malformed/unparseable content rather than throwing — a bad bundle is always just a cache miss. */
export function parseExampleExchangeBundle(raw: string): ExampleExchangeBundle | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = exampleExchangeBundleSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

// Same text RelevantExampleExchangeSelector's BM25 scorer concatenates
// (tags + user + character) — embedding the identical text keeps the
// lexical and embedding signals scoring the same underlying content.
function embeddingText(exchange: { tags: string; user: string; character: string }): string {
  return `${exchange.tags} ${exchange.user} ${exchange.character}`;
}

/**
 * Embeds each parsed exchange and builds the bundle to write to disk. Best-
 * effort per exchange — an embedding failure degrades that exchange to
 * `embedding: null` (lexical-only at selection time) rather than failing the
 * whole upload; see PersonaBundleCompiler for the equivalent pattern.
 */
export async function buildExampleExchangeBundle(
  content: string,
  exchanges: readonly ExampleExchange[],
  embeddingsClient: EmbeddingsClient,
): Promise<ExampleExchangeBundle> {
  const embeddings = await embedTextsBestEffort(exchanges.map(embeddingText), embeddingsClient);
  const embedded = exchanges.map((exchange, index) => ({
    tags: exchange.tags,
    user: exchange.user,
    character: exchange.character,
    embedding: embeddings[index] ?? null,
  }));
  return { sourceHash: hashContent(content), exchanges: embedded };
}
