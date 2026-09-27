import type { EffectInstance } from "../../../src/domain/campaign/effects/effect-instance.js";
import type { ContentId } from "../../../src/domain/campaign/rules/content-id.js";

// A condition as a lasting effect on a creature, without a clock: it stays until removed.
export function appliedCondition(condition: ContentId<"condition">, sourceId = "test-source", clock: EffectInstance["clock"] = null): EffectInstance {
  return { id: `test:${condition}:${sourceId}`, definition: condition, sourceId, conditions: [condition], modifiers: [], triggers: [], clock, concentrationId: null, stacking: "ignore" };
}
