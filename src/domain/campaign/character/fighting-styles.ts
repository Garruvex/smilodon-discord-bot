// Fighting Style: fighters, paladins and rangers hold one style feature, and may swap it for another while
// they level up. The starting style is Dueling; the others are chosen in the level-up form.
export const fightingStyles = ["feature:fighting-style-dueling", "feature:fighting-style-archery", "feature:fighting-style-defense"] as const;
export type FightingStyleId = (typeof fightingStyles)[number];

export const isFightingStyle = (id: string): id is FightingStyleId => (fightingStyles as readonly string[]).includes(id);

// The style a hero holds, or null when their class has none.
export function heldFightingStyle(features: readonly string[]): FightingStyleId | null {
  return features.find(isFightingStyle) ?? null;
}

// The feature list with the held style replaced by another (unchanged when the hero holds none).
export function swapFightingStyle<F extends string>(features: readonly F[], styleId: FightingStyleId): readonly F[] {
  return features.map((feature) => (isFightingStyle(feature) ? (styleId as F) : feature));
}
