// Retrieval weight only: this neither expires evidence nor changes confidence.
export function fadingWeight(now: number, supportedAt: number, halfLifeDays: number): number {
  return 2 ** (-Math.max(0, now - supportedAt) / (halfLifeDays * 86_400_000));
}
