import { expect } from "vitest";

import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import type { CharacterSheet } from "../../../src/domain/campaign/character/character-sheet.js";
import type { Actor, CampaignCommand } from "../../../src/domain/campaign/commands/campaign-command.js";
import { buildSrd51 } from "../../../src/domain/campaign/content/srd-5.1/index.js";
import type { D20TestRoll } from "../../../src/domain/campaign/dice/d20-test.js";
import type { RollMode } from "../../../src/domain/campaign/dice/roll.js";
import { decide } from "../../../src/domain/campaign/engine/decide.js";
import type { EngineRequest } from "../../../src/domain/campaign/engine/engine-request.js";
import type { Rejection } from "../../../src/domain/campaign/engine/rejection.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import { replay } from "../../../src/domain/campaign/events/evolve.js";
import { milestone0Capabilities } from "../../../src/domain/campaign/rules/capabilities.js";
import { resolveHouseRules } from "../../../src/domain/campaign/rules/house-rules.js";
import type { SealedRuleset } from "../../../src/domain/campaign/rules/ruleset.js";
import type { CampaignState, Pacing } from "../../../src/domain/campaign/state/campaign-state.js";

const content = buildSrd51({ capabilities: milestone0Capabilities, glossaries: [enSrd51Glossary, zhTwSrd51Glossary] });

export function ruleset(houseRules: Record<string, string> = {}): SealedRuleset {
  return { content, houseRules: resolveHouseRules(houseRules) };
}

export const organizer: Actor = { kind: "user", userId: "u-organizer" };
export const alex: Actor = { kind: "user", userId: "u-alex" };
export const jamie: Actor = { kind: "user", userId: "u-jamie" };
export const system: Actor = { kind: "system" };

// Level-1 Rogue with Stealth expertise: DEX 16 (+3), proficiency +2, so +7.
export const mira: CharacterSheet = {
  id: "c-mira",
  ownerUserId: "u-alex",
  name: "Mira",
  abilityScores: { str: 8, dex: 16, con: 12, int: 13, wis: 10, cha: 14 },
  proficiencyBonus: 2,
  skills: { stealth: "expertise", perception: "proficient" },
  savingThrows: ["dex", "int"],
  level: 1,
  maxHp: 9,
  hitDie: 8,
  speed: 30,
  equipment: ["item:shortsword", "item:shortbow", "item:leather-armor"],
  features: ["feature:sneak-attack", "feature:thieves-cant"],
  spellcasting: null,
};

// Level-1 Fighter: STR 16 (+3), Athletics proficient, so +5.
export const borin: CharacterSheet = {
  id: "c-borin",
  ownerUserId: "u-jamie",
  name: "Borin",
  abilityScores: { str: 16, dex: 12, con: 15, int: 10, wis: 12, cha: 8 },
  proficiencyBonus: 2,
  skills: { athletics: "proficient" },
  savingThrows: ["str", "con"],
  level: 1,
  maxHp: 12,
  hitDie: 10,
  speed: 30,
  equipment: ["item:longsword", "item:chain-mail", "item:shield"],
  features: ["feature:fighting-style-dueling", "feature:second-wind"],
  spellcasting: null,
};

// Level-1 Life Cleric: WIS 16 (+3), so spell attack +5 and save DC 13.
export const elspeth: CharacterSheet = {
  id: "c-elspeth",
  ownerUserId: "u-sam",
  name: "Elspeth",
  abilityScores: { str: 14, dex: 10, con: 13, int: 10, wis: 16, cha: 12 },
  proficiencyBonus: 2,
  skills: { insight: "proficient", medicine: "proficient" },
  savingThrows: ["wis", "cha"],
  level: 1,
  maxHp: 9,
  hitDie: 8,
  speed: 30,
  equipment: ["item:mace", "item:chain-mail", "item:shield"],
  features: ["feature:disciple-of-life"],
  spellcasting: {
    ability: "wis",
    spells: ["spell:sacred-flame", "spell:bless", "spell:cure-wounds", "spell:healing-word", "spell:guiding-bolt"],
    slots: { 1: 2 },
  },
};

export const sam: Actor = { kind: "user", userId: "u-sam" };

// Mira, Borin, and Elspeth.
export function partyOfThree(): CampaignState {
  const base = newCampaign();
  return {
    ...base,
    members: { ...base.members, "u-sam": { userId: "u-sam", characterId: "c-elspeth", availability: "present", consecutiveMisses: 0 } },
    characters: { ...base.characters, "c-elspeth": elspeth },
  };
}

export const livePacing: Pacing = { roundSeconds: 300, rollSeconds: 120, turnSeconds: 180, awayAfterMisses: 2 };

export function newCampaign(pacing: Pacing = livePacing): CampaignState {
  return {
    campaignId: "camp-1",
    organizerId: "u-organizer",
    status: "active",
    language: "en",
    pacing,
    sceneId: null,
    members: {
      "u-alex": { userId: "u-alex", characterId: "c-mira", availability: "present", consecutiveMisses: 0 },
      "u-jamie": { userId: "u-jamie", characterId: "c-borin", availability: "present", consecutiveMisses: 0 },
    },
    characters: { "c-mira": mira, "c-borin": borin },
    round: null,
    lastRoundNumber: 0,
    lastNarratedRound: 0,
    checks: {},
    ledger: {},
    encounter: null,
    heroStatus: {},
    pendingEncounter: null,
    encounterHistory: [],
  };
}

export interface Step {
  readonly state: CampaignState;
  readonly events: readonly CampaignEvent[];
  readonly requests: readonly EngineRequest[];
}

export interface RunOptions {
  readonly now?: number;
  readonly rules?: SealedRuleset;
}

// Runs one accepted command and returns the next state rebuilt by replaying
// its events, so every scenario also proves decide() and evolve() agree.
export function run(state: CampaignState, actor: Actor, command: CampaignCommand, options: RunOptions = {}): Step {
  const result = decide(state, command, { rules: options.rules ?? ruleset(), now: options.now ?? 0, actor });
  if (result.kind === "rejected") throw new Error(`Expected ${command.kind} to be accepted: ${JSON.stringify(result.rejection)}`);
  return { state: replay(state, result.events), events: result.events, requests: result.requests };
}

export function reject(state: CampaignState, actor: Actor, command: CampaignCommand, options: RunOptions = {}): Rejection {
  const result = decide(state, command, { rules: options.rules ?? ruleset(), now: options.now ?? 0, actor });
  expect(result.kind).toBe("rejected");
  if (result.kind !== "rejected") throw new Error("unreachable");
  return result.rejection;
}

export function kinds(events: readonly { readonly kind: string }[]): readonly string[] {
  return events.map((event) => event.kind);
}

// A saved d20 test roll with explicit dice, as the roll worker would record it.
export function d20Roll(
  mode: RollMode,
  values: readonly number[],
  modifier: number,
  bonus: readonly { source: string; value: number }[] = [],
): D20TestRoll {
  const natural = mode === "advantage" ? Math.max(...values) : Math.min(...values);
  const bonusDice = bonus.map((die) => ({
    source: die.source,
    roll: { expression: { terms: [{ count: 1, sides: 4 as const }], modifier: 0 }, terms: [{ sides: 4 as const, values: [die.value] }], modifier: 0, total: die.value },
  }));
  const d20Total = natural + modifier;
  return {
    d20: { mode, values, natural, modifier, total: d20Total },
    bonusDice,
    total: d20Total + bonus.reduce((sum, die) => sum + die.value, 0),
  };
}
