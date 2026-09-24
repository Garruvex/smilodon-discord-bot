import { z } from "zod";

import { hashContent } from "../assets/content-hash.js";
import type { ExampleExchange } from "./example-exchange.js";
import type { EmbeddingsClient } from "./embeddings-client.js";
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
  // Fingerprint (see EmbeddingsClient.modelId) of whatever embeddings client
  // produced these exchanges' vectors, or null when none was configured at
  // build time — same convention as PersonaBundle.embeddingModel. Read back
  // and compared against the active client at load time (see
  // FilePersonaSource), not just when rebuilding, so a provider/model
  // switch can't compare vectors from incompatible semantic spaces just
  // because nobody reuploaded examples.md since. Defaults to null so
  // bundles written before this field existed still parse.
  embeddingModel: z.string().nullable().default(null),
  // Which exampleExchangeEmbeddingText scheme produced these vectors — same
  // convention as PersonaBundle.embeddingTextVersion. Bundles predating
  // this field embedded tags + user + character.
  embeddingTextVersion: z.number().int().default(1),
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

export const exampleExchangeEmbeddingTextVersion = 2;

// The situation an example responds to (tags + User line), not the
// Character reply — the per-turn query is an incoming user message, so it
// should be compared against the example's user side. Including the reply
// diluted the match with text the query never resembles. Same fields
// RelevantExampleExchangeSelector's BM25 scorer indexes.
export function exampleExchangeEmbeddingText(exchange: { tags: string; user: string }): string {
  return `${exchange.tags}\n${exchange.user}`;
}

/**
 * Embeds each parsed exchange and builds the bundle to write to disk. Best-
 * effort per exchange — an embedding failure degrades that exchange to
 * `embedding: null` (lexical-only at selection time) rather than failing the
 * whole upload; see PersonaBundleCompiler for the equivalent pattern.
 * `previousBundle`'s vectors are reused for unchanged exchanges when they
 * came from the same model and embedding-text scheme.
 */
export async function buildExampleExchangeBundle(
  content: string,
  exchanges: readonly ExampleExchange[],
  embeddingsClient: EmbeddingsClient,
  previousBundle: ExampleExchangeBundle | null = null,
): Promise<ExampleExchangeBundle> {
  const reusable = previousBundle?.embeddingModel === embeddingsClient.modelId
    && previousBundle.embeddingTextVersion === exampleExchangeEmbeddingTextVersion
    ? new Map(previousBundle.exchanges
        .filter((exchange) => exchange.embedding !== null)
        .map((exchange) => [exampleExchangeEmbeddingText(exchange), exchange.embedding] as const))
    : new Map<string, number[] | null>();
  const texts = exchanges.map(exampleExchangeEmbeddingText);
  const missing = [...new Set(texts.filter((text) => !reusable.has(text)))];
  const fresh = missing.length > 0 ? await embedTextsBestEffort(missing, embeddingsClient) : [];
  const freshByText = new Map(missing.map((text, index) => [text, fresh[index] ?? null]));
  const embedded = exchanges.map((exchange, index) => ({
    tags: exchange.tags,
    user: exchange.user,
    character: exchange.character,
    embedding: reusable.get(texts[index]!) ?? freshByText.get(texts[index]!) ?? null,
  }));
  return {
    sourceHash: hashContent(content),
    exchanges: embedded,
    embeddingModel: embeddingsClient.modelId,
    embeddingTextVersion: exampleExchangeEmbeddingTextVersion,
  };
}
