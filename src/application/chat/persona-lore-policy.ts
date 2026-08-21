export const personaLoreLimits = {
  // Smaller than chatMemoryLimits' per-source budget — lore is a
  // supplementary layer on top of the always-sent personality core, not a
  // primary content source, so it gets a tighter slice of the prompt.
  maxSelectedChars: 4_000,
} as const;
