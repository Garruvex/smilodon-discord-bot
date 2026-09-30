import { describe, expect, it } from "vitest";

import { CryptoRandomSource } from "../../../src/application/campaign/random/crypto-random-source.js";
import { SeededRandomSource } from "../../../src/application/campaign/random/seeded-random-source.js";

describe("SeededRandomSource", () => {
  it("repeats the same sequence for the same seed", () => {
    const a = new SeededRandomSource(42);
    const b = new SeededRandomSource(42);
    const sequenceA = Array.from({ length: 20 }, () => a.nextInt(1, 20));
    const sequenceB = Array.from({ length: 20 }, () => b.nextInt(1, 20));
    expect(sequenceA).toEqual(sequenceB);
  });

  it("differs between seeds", () => {
    const a = Array.from({ length: 20 }, (_, index) => new SeededRandomSource(index).nextInt(1, 1000));
    expect(new Set(a).size).toBeGreaterThan(1);
  });

  it("covers the whole range and nothing outside it", () => {
    const source = new SeededRandomSource(7);
    const seen = new Set(Array.from({ length: 2000 }, () => source.nextInt(1, 6)));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("CryptoRandomSource", () => {
  it("stays within the inclusive range", () => {
    const source = new CryptoRandomSource();
    const seen = new Set(Array.from({ length: 2000 }, () => source.nextInt(1, 4)));
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });
});
