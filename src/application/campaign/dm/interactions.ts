import { interactionsOf, type AdventureBible, type BibleEffect, type BibleInteraction, type BibleRequirement } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";

// The authored interactions of a scene, as the engine and the Planner see them. Flags the engine keeps for its own bookkeeping.
export const triedFlag = (id: string): string => `tried:${id}`;
export const doneFlag = (id: string): string => `done:${id}`;

const flagSet = (state: CampaignState, flag: string): boolean => (state.flags?.[flag] ?? 0) > 0;

export function requirementMet(requires: BibleRequirement | undefined, state: CampaignState): boolean {
  if (requires === undefined) return true;
  return (
    (requires.clues ?? []).every((clue) => state.clues.some((known) => known.id === clue)) &&
    (requires.flags ?? []).every((flag) => flagSet(state, flag)) &&
    (requires.notFlags ?? []).every((flag) => !flagSet(state, flag))
  );
}

// What the party can attempt right now: in this scene, requirements met, not already succeeded, attempts left.
export function availableInteractions(bible: AdventureBible, state: CampaignState): readonly BibleInteraction[] {
  return interactionsOf(bible).filter(
    (interaction) =>
      interaction.sceneId === state.sceneId &&
      requirementMet(interaction.requires, state) &&
      !flagSet(state, doneFlag(interaction.id)) &&
      (state.flags?.[triedFlag(interaction.id)] ?? 0) < interaction.attempts,
  );
}

// The scenes the party can go to from where it stands. A scene without exits lets the Planner send the party anywhere.
export function reachableScenes(bible: AdventureBible, state: CampaignState): readonly string[] {
  const here = bible.scenes.find((scene) => scene.id === state.sceneId);
  if (here?.exits === undefined) return bible.scenes.map((scene) => scene.id);
  return here.exits.filter((exit) => requirementMet(exit.requires, state)).map((exit) => exit.to);
}

// Whose gold pays, from the table's loot-gold rule: each hero's own, or the party purse.
export type Wallet = "pool" | "hero";

export function goldOf(state: CampaignState, characterId: string, wallet: Wallet): number {
  return wallet === "hero" ? (state.heroGold?.[characterId] ?? 0) : state.gold;
}

function describeEffect(effect: BibleEffect): string {
  switch (effect.kind) {
    case "reveal":
      return `the party learns ${effect.clue}`;
    case "set":
      return `flag ${effect.flag} is set`;
    case "reward":
      return `reward: ${[...(effect.gold === undefined ? [] : [`${effect.gold} gold`]), ...(effect.items ?? [])].join(", ")}`;
    case "goto":
      return `the party moves to ${effect.scene}`;
    case "encounter":
      return `${effect.encounter} begins`;
    case "clock":
      return `${effect.clock} advances by ${effect.by}`;
    case "notice":
      return `the table is told: "${effect.text}"`;
    case "keepsake":
      return `the party receives ${effect.name}`;
    case "hurt":
      return `${effect.who === "party" ? "every hero" : "the hero"} takes ${effect.count}d${effect.sides} ${effect.damageType} damage`;
    case "random":
      return `one of, chosen by chance: ${effect.options.map((option) => describeEffects(option.effects)).join(" | ")}`;
  }
}

const describeEffects = (effects: readonly BibleEffect[]): string => (effects.length === 0 ? "nothing" : effects.map(describeEffect).join("; "));

// One interaction for the Planner's context (never the Narrator's): what it is, how it is rolled, what follows, and when it applies.
export function describeInteraction(interaction: BibleInteraction): string {
  const { check } = interaction;
  const roll = check === null ? "happens on its own, no roll" : `${check.skill ?? check.ability} ${check.save === true ? "saving throw" : "check"}, DC ${check.dc}`;
  const needs = [
    ...(interaction.requires.clues ?? []).map((clue) => `clue ${clue}`),
    ...(interaction.requires.flags ?? []).map((flag) => `flag ${flag}`),
    ...(interaction.requires.notFlags ?? []).map((flag) => `flag ${flag} not set`),
  ];
  const lines = [
    `${interaction.id} in ${interaction.sceneId}: ${interaction.label}`,
    `Rolled as: ${roll}. Tries allowed: ${interaction.attempts}.${interaction.pay > 0 ? ` The hero pays ${interaction.pay} gold.` : ""}${needs.length > 0 ? ` Needs: ${needs.join(", ")}.` : ""}`,
    `On success: ${describeEffects(interaction.onSuccess)}.${interaction.tiers.map((tier) => ` With a total of ${tier.dc}+: ${describeEffects(tier.effects)}.`).join("")}${check === null ? "" : ` On failure: ${describeEffects(interaction.onFailure)}.`}`,
    `DM notes: ${interaction.dmNotes}`,
  ];
  return lines.join("\n");
}
