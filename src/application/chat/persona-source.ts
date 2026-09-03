import type { GuildConfiguration } from "../../config/guild-configuration.js";
import type { ExampleExchange } from "./example-exchange.js";

// One retrievable lore/knowledge section of a compiled personality bundle
// (see persona-bundle-compiler.ts). `embedding` is null when embeddings
// weren't available at compile time — PersonaLoreSelector treats that as a
// 0 similarity contribution, same convention as ChatMemoryRecord.embedding.
export interface PersonaLoreChunk {
  heading: string;
  text: string;
  embedding: readonly number[] | null;
}

/**
 * The stable persona material used for one chat turn. Implementations may
 * load it from files, a database, or another configured source, but should
 * not rewrite the persona from conversation context.
 */
export interface ResolvedPersona {
  personality: string;
  // Retrievable lore chunks from a compiled personality bundle — empty when
  // no bundle exists or it's stale relative to the current file (see
  // FilePersonaSource), in which case `personality` already carries the
  // full file content and nothing further needs retrieving.
  loreChunks: readonly PersonaLoreChunk[];
  examplePool: readonly ExampleExchange[];
  // The guild's current evolved persona-drift text (see
  // persona-drift-store.ts), or null when the guild has the feature
  // disabled, nothing has evolved yet, or the file is missing/unreadable.
  personaDrift: string | null;
  // Hash identifying the complete uploaded personality source this persona
  // was resolved from — the whole file (lore included), not just
  // `personality`'s always-sent core. A compiled bundle sends only the core
  // as `personality`, so hashing `personality` alone would miss a lore-only
  // edit and let stale persona-drift survive against contradicted lore; use
  // this hash for drift invalidation instead. See FilePersonaSource.
  personalitySourceHash: string;
}

/** Resolves the configured persona independently of the chat transport. */
export interface PersonaSource {
  resolve(profile: GuildConfiguration): Promise<ResolvedPersona>;
}
