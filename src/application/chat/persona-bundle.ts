import { z } from "zod";

// Sidecar JSON written next to an uploaded personality.md
// (guild-assets/{guildId}/personality.bundle.json) by PersonaBundleCompiler
// at upload time, and read back by FilePersonaSource on every turn. Never
// hand-authored — always machine-generated from the current file content.
export const personaBundleSchema = z.object({
  sourceHash: z.string(),
  core: z.string(),
  chunks: z.array(z.object({
    heading: z.string(),
    text: z.string(),
    embedding: z.array(z.number()).nullable(),
  })),
  compiledAt: z.number(),
  // Fingerprint (provider+model+dimensionality — see EmbeddingsClient.modelId)
  // of whatever embeddings client produced this bundle's chunk vectors, or
  // null when none was configured at compile time. PersonaBundleCompiler
  // only reuses a chunk's cached vector on a reupload when this matches the
  // current embeddings client's modelId — otherwise a provider/model switch
  // could silently mix vectors from incompatible semantic spaces, even at
  // matching dimensionality. Defaults to null so bundles written before this
  // field existed still parse (as "unknown", never reused).
  embeddingModel: z.string().nullable().default(null),
  // Which personaLoreEmbeddingText scheme produced the chunk vectors. A
  // mismatch means they embed different text than today's queries are
  // compared against, so they're treated like an embeddingModel mismatch
  // (dropped/never reused). Bundles predating this field embedded body only.
  embeddingTextVersion: z.number().int().default(1),
});

export type PersonaBundle = z.infer<typeof personaBundleSchema>;

export const personaLoreEmbeddingTextVersion = 2;

// Heading included — it's often the most specific signal a section has
// ("Relationship with Bob"), and BM25 already indexes it.
export function personaLoreEmbeddingText(chunk: { heading: string; text: string }): string {
  return `${chunk.heading}\n${chunk.text}`;
}

export function serializePersonaBundle(bundle: PersonaBundle): string {
  return JSON.stringify(bundle);
}

/** Returns null for missing/malformed/unparseable content rather than throwing — a bad bundle is always just a cache miss. */
export function parsePersonaBundle(raw: string): PersonaBundle | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = personaBundleSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
