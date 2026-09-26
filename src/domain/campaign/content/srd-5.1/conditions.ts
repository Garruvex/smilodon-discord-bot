import { defineCondition, type ConditionDefinition } from "../../rules/content-definitions.js";

// The milestone 0 subset of SRD 5.1 conditions. What each condition does
// mechanically lives in the engine; these entries identify them and record
// which conditions imply others.

const source = "SRD 5.1";

export const incapacitated = defineCondition({ id: "condition:incapacitated", source, includes: [] });
export const prone = defineCondition({ id: "condition:prone", source, includes: [] });
export const frightened = defineCondition({ id: "condition:frightened", source, includes: [] });
export const poisoned = defineCondition({ id: "condition:poisoned", source, includes: [] });
export const unconscious = defineCondition({
  id: "condition:unconscious",
  source,
  includes: [incapacitated.id, prone.id],
});

export const srd51Conditions: readonly ConditionDefinition[] = [incapacitated, prone, frightened, poisoned, unconscious];
