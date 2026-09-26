// The only way randomness reaches campaign dice. The domain never calls
// Math.random or crypto itself: the application supplies a cryptographic
// source in production and a seeded or scripted one in tests and the
// headless harness, which is what makes rolls reproducible.
export interface RandomSource {
  // Uniform integer in [minInclusive, maxInclusive].
  nextInt(minInclusive: number, maxInclusive: number): number;
}
