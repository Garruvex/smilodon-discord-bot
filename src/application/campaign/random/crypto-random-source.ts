import { randomInt } from "node:crypto";

import type { RandomSource } from "../../../domain/campaign/dice/random-source.js";

// Production dice. crypto.randomInt is uniform (no modulo bias) and its
// upper bound is exclusive, hence the +1.
export class CryptoRandomSource implements RandomSource {
  public nextInt(minInclusive: number, maxInclusive: number): number {
    return randomInt(minInclusive, maxInclusive + 1);
  }
}
