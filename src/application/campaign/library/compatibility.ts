import { buildProblems, deriveSheet, type BuildChoices, type BuildProblem } from "../../../domain/campaign/character/character-build.js";
import { applyProgression, progressionProblems, type Progression, type ProgressionProblem } from "../../../domain/campaign/character/leveling.js";
import type { SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import type { SnapshotGear } from "./library-types.js";

// Why a saved character cannot join a campaign as it is (plan §3: name the
// exact conflicts, never silently drop progress or grant something the
// campaign's rules do not have).
export type ImportConflict =
  | { readonly code: "rulesetMismatch"; readonly expected: string; readonly actual: string }
  | { readonly code: "invalidBuild"; readonly problem: BuildProblem }
  | { readonly code: "invalidProgression"; readonly problem: ProgressionProblem }
  | { readonly code: "unknownContent"; readonly id: string; readonly as: "item" | "feature" | "spell" }
  | { readonly code: "wornNotCarried"; readonly id: string };

export interface CompatibilitySubject {
  readonly rulesetId: string;
  readonly build: BuildChoices;
  readonly gear: SnapshotGear;
  readonly progression?: Progression;
}

// Checks a snapshot against a campaign's sealed content. Nothing here trusts a
// stored number: the build is validated again, and every item, feature and
// spell the derived hero would carry must exist in the campaign's ruleset.
export function checkCompatibility(subject: CompatibilitySubject, content: SealedContent): readonly ImportConflict[] {
  const conflicts: ImportConflict[] = [];
  if (subject.rulesetId !== content.rulesetId) conflicts.push({ code: "rulesetMismatch", expected: content.rulesetId, actual: subject.rulesetId });
  const problems = buildProblems(subject.build);
  for (const problem of problems) conflicts.push({ code: "invalidBuild", problem });
  // A broken build cannot be derived, so stop at what is wrong with it.
  if (problems.length > 0) return conflicts;

  const base = deriveSheet(subject.build, subject.gear);
  const progressProblems = subject.progression === undefined ? [] : progressionProblems(base, subject.progression);
  for (const problem of progressProblems) conflicts.push({ code: "invalidProgression", problem });
  if (progressProblems.length > 0) return conflicts;
  const sheet = subject.progression === undefined ? base : applyProgression(base, subject.progression);
  const expect = (id: string, kind: "item" | "feature" | "spell"): void => {
    if (content.find(id)?.kind !== kind) conflicts.push({ code: "unknownContent", id, as: kind });
  };
  for (const id of new Set(sheet.equipment)) expect(id, "item");
  for (const id of sheet.features) expect(id, "feature");
  for (const id of sheet.spellcasting?.spells ?? []) expect(id, "spell");
  for (const id of subject.gear.worn ?? []) if (!sheet.equipment.includes(id)) conflicts.push({ code: "wornNotCarried", id });
  return conflicts;
}
