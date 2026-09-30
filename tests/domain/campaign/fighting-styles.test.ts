import { describe, expect, it } from "vitest";
import type { Combatant } from "../../../src/domain/campaign/combat/combat-state.js";

import { deriveSheet, type BuildChoices } from "../../../src/domain/campaign/character/character-build.js";
import type { CharacterSheet } from "../../../src/domain/campaign/character/character-sheet.js";
import { heldFightingStyle } from "../../../src/domain/campaign/character/fighting-styles.js";
import { defaultHeroResources } from "../../../src/domain/campaign/character/hero-status.js";
import { applyProgression, progressionOf } from "../../../src/domain/campaign/character/leveling.js";
import { heroCombatant } from "../../../src/domain/campaign/combat/combatant-profile.js";
import { jamie, newCampaign, reject, ruleset, run } from "./campaign-fixtures.js";

const build: BuildChoices = {
  class: "fighter",
  kit: "knight",
  abilities: { str: 15, dex: 14, con: 14, int: 8, wis: 13, cha: 10 },
  skills: ["athletics", "history"],
  expertise: [],
  name: "Torvin",
  appearance: "",
  backstory: "",
};

function combatantWith(features: readonly string[], equipment: readonly string[]): Combatant {
  const content = ruleset().content;
  const sheet = { ...deriveSheet(build), id: "c-t", ownerUserId: "u-t", features, equipment } as unknown as CharacterSheet;
  return heroCombatant(sheet, content, "gate", { hp: sheet.maxHp, resources: defaultHeroResources(sheet, content) });
}

describe("fighting style", () => {
  it("starts as Dueling and can be swapped by the hero's player", () => {
    const state = newCampaign();
    expect(heldFightingStyle(state.characters["c-borin"]?.features ?? [])).toBe("feature:fighting-style-dueling");
    const step = run(state, jamie, { kind: "chooseFightingStyle", characterId: "c-borin", styleId: "feature:fighting-style-archery" });
    const features = step.state.characters["c-borin"]?.features ?? [];
    expect(features).toContain("feature:fighting-style-archery");
    expect(features).not.toContain("feature:fighting-style-dueling");
  });

  it("refuses an unknown style, and a hero whose class gives none", () => {
    const state = newCampaign();
    expect(reject(state, jamie, { kind: "chooseFightingStyle", characterId: "c-borin", styleId: "feature:second-wind" })).toEqual({ code: "unknownFeature" });
    const caster = Object.values(state.characters).find((sheet) => heldFightingStyle(sheet.features) === null);
    if (caster !== undefined) expect(reject(state, { kind: "user", userId: caster.ownerUserId }, { kind: "chooseFightingStyle", characterId: caster.id, styleId: "feature:fighting-style-archery" })).toEqual({ code: "unknownFeature" });
  });

  it("adds 2 to ranged attack rolls with Archery, and not to melee ones", () => {
    const plain = combatantWith(["feature:fighting-style-dueling"], ["item:longbow", "item:longsword"]);
    const archer = combatantWith(["feature:fighting-style-archery"], ["item:longbow", "item:longsword"]);
    const toHit = (combatant: typeof plain, weapon: string): number => combatant.attacks.find((attack) => attack.weapon === weapon)?.toHit ?? 0;
    expect(toHit(archer, "item:longbow")).toBe(toHit(plain, "item:longbow") + 2);
    expect(toHit(archer, "item:longsword")).toBe(toHit(plain, "item:longsword"));
  });

  it("adds 1 to armor class with Defense only while armored", () => {
    const armored = combatantWith(["feature:fighting-style-defense"], ["item:chain-mail"]);
    const armoredPlain = combatantWith(["feature:fighting-style-dueling"], ["item:chain-mail"]);
    const bare = combatantWith(["feature:fighting-style-defense"], ["item:longsword"]);
    const barePlain = combatantWith(["feature:fighting-style-dueling"], ["item:longsword"]);
    expect(armored.armorClass).toBe(armoredPlain.armorClass + 1);
    expect(bare.armorClass).toBe(barePlain.armorClass);
  });

  it("keeps the chosen style in saved progress", () => {
    const base = { ...deriveSheet(build), id: "c-t", ownerUserId: "u-t" } as unknown as CharacterSheet;
    const swapped = { ...base, features: base.features.map((id) => (id === "feature:fighting-style-dueling" ? ("feature:fighting-style-defense" as const) : id)) };
    const saved = progressionOf(swapped);
    expect(saved.fightingStyle).toBe("feature:fighting-style-defense");
    expect(applyProgression(deriveSheet(build), saved).features).toContain("feature:fighting-style-defense");
  });
});
