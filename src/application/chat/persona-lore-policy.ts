export const personaLoreLimits = {
  // Smaller than chatMemoryLimits' per-source budget — lore is a
  // supplementary layer on top of the always-sent personality core, not a
  // primary content source, so it gets a tighter slice of the prompt.
  maxSelectedChars: 4_000,
  // Longer `##` sections are split into parts no bigger than this (see
  // splitLoreChunks). Must stay well under maxSelectedChars: selection skips
  // any chunk that doesn't fit the remaining budget, so an oversized section
  // would otherwise never be sent at all. Smaller parts also embed more
  // precisely than one vector averaged over a long section.
  maxChunkChars: 1_200,
} as const;
