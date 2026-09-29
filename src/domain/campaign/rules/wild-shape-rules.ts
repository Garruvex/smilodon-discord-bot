import type { MonsterDefinition } from "./content-definitions.js";
import type { ContentId } from "./content-id.js";

// Wild Shape (SRD 5.1 Druid): two uses between short rests, and the beasts a
// druid may take depend on their level. Circle of the Moon's wider cap is not
// modeled (subclasses are not implemented).
export const wildShapeFeature: ContentId<"feature"> = "feature:wild-shape";
export const wildShapeUses = 2;

// The highest challenge rating a druid of this level may take, and whether that
// form may fly or swim: level 2 has no fly/swim and CR 1/4, level 4 allows
// swimming and CR 1/2, level 8 allows flying and CR 1.
export function wildShapeLimit(level: number): { readonly challengeRating: number; readonly flies: boolean; readonly swims: boolean } | null {
  if (level >= 8) return { challengeRating: 1, flies: true, swims: true };
  if (level >= 4) return { challengeRating: 0.5, flies: false, swims: true };
  if (level >= 2) return { challengeRating: 0.25, flies: false, swims: false };
  return null;
}

export function mayWildShapeInto(level: number, beast: MonsterDefinition): boolean {
  const limit = wildShapeLimit(level);
  const form = beast.beast;
  if (limit === null || form === undefined) return false;
  return form.challengeRating <= limit.challengeRating && (!form.flies || limit.flies) && (!form.swims || limit.swims);
}
