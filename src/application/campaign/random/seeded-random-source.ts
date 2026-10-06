import type { RandomSource } from "../../../domain/campaign/dice/random-source.js";

// Reproducible dice for tests and the headless harness (mulberry32). Not for
// production: the sequence is predictable from the seed by design.
export class SeededRandomSource implements RandomSource {
  private state: number;

  public constructor(seed: number) {
    this.state = seed >>> 0;
  }

  public nextInt(minInclusive: number, maxInclusive: number): number {
    const span = maxInclusive - minInclusive + 1;
    return minInclusive + Math.floor(this.next() * span);
  }

  private next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
