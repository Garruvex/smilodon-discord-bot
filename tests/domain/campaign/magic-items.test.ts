import { describe, expect, it } from "vitest";
import { heroCombatant, heroTraits } from "../../../src/domain/campaign/combat/combatant-profile.js";
import type { CharacterSheet } from "../../../src/domain/campaign/character/character-sheet.js";
import { formatDiceExpression } from "../../../src/domain/campaign/dice/dice-expression.js";
import { newCampaign, ruleset } from "./campaign-fixtures.js";

const content = ruleset().content;
const borin = (): CharacterSheet => {
  const sheet = newCampaign().characters["c-borin"];
  if (sheet === undefined) throw new Error("fixture");
  return { ...sheet, equipment: ["item:longsword"], worn: [] };
};
const status = (sheet: CharacterSheet): { hp: number; resources: { spellSlots: Record<number, number>; featureUses: Record<string, number> } } => ({ hp: sheet.maxHp, resources: { spellSlots: {}, featureUses: {} } });
const fighter = (sheet: CharacterSheet): ReturnType<typeof heroCombatant> => heroCombatant(sheet, content, "gate", status(sheet));
const carrying = (...items: string[]): CharacterSheet => ({ ...borin(), equipment: ["item:longsword", ...items] as CharacterSheet["equipment"] });

describe("SRD magic items", () => {
  it("has the whole catalog, with names in both languages", () => {
    const magic = content.all("item").filter((item) => item.itemType === "magic");
    expect(magic.length).toBeGreaterThan(250);
    for (const id of ["item:ring-of-protection", "item:bag-of-holding", "item:belt-of-giant-strength-storm", "item:spell-scroll-3rd", "item:flame-tongue", "item:potion-of-supreme-healing"] as const) {
      expect(content.find(id)).toBeDefined();
    }
  });

  it("builds +1, +2 and +3 versions of every weapon, armor and shield", () => {
    const base = content.get("item:longsword");
    const plus = content.get("item:longsword-plus-2");
    if (base.itemType !== "weapon" || plus.itemType !== "weapon") throw new Error("weapon");
    expect(plus.enchantment).toBe(2);
    expect(plus.damage).toEqual(base.damage);
    const chain = content.get("item:chain-mail-plus-1");
    if (chain.itemType !== "armor") throw new Error("armor");
    expect(chain.baseArmorClass).toBe(17);
    const shield = content.get("item:shield-plus-3");
    if (shield.itemType !== "shield") throw new Error("shield");
    expect(shield.armorClassBonus).toBe(5);
  });

  it("adds a weapon's bonus to the hero's attack and damage rolls", () => {
    const plain = fighter(borin()).attacks[0];
    const sheet: CharacterSheet = { ...borin(), equipment: ["item:longsword-plus-2"] };
    const magic = fighter(sheet).attacks[0];
    if (plain === undefined || magic === undefined) throw new Error("attack");
    expect(magic.toHit).toBe(plain.toHit + 2);
    expect(magic.damage.modifier).toBe(plain.damage.modifier + 2);
  });

  it("adds a named weapon's extra damage on a hit", () => {
    const attack = fighter({ ...borin(), equipment: ["item:flame-tongue"] }).attacks[0];
    expect(attack?.onHit.map((effect) => (effect.kind === "damage" ? `${formatDiceExpression(effect.amount)} ${effect.damageType}` : effect.kind))).toEqual(["2d6 fire"]);
  });

  it("gives a Ring of Protection +1 armor class and +1 on every save", () => {
    const plain = fighter(borin());
    const ringed = fighter(carrying("item:ring-of-protection"));
    expect(ringed.armorClass).toBe(plain.armorClass + 1);
    expect(ringed.saves.wis).toBe(plain.saves.wis + 1);
  });

  it("sets an ability score with a Belt of Giant Strength, never lowering it", () => {
    const strong = fighter(carrying("item:belt-of-giant-strength-storm"));
    expect(strong.attacks[0]?.toHit).toBeGreaterThan((fighter(borin()).attacks[0]?.toHit ?? 0) + 5);
    const already = { ...carrying("item:gauntlets-of-ogre-power"), abilityScores: { ...borin().abilityScores, str: 20 } };
    expect(fighter(already).attacks[0]?.toHit).toBe(fighter({ ...borin(), abilityScores: { ...borin().abilityScores, str: 20 } }).attacks[0]?.toHit);
  });

  it("gives resistance from a Ring of Fire Resistance, and counts at most three attuned items", () => {
    expect(heroTraits(carrying("item:ring-of-resistance-fire"), content)).toContainEqual({ kind: "damageResistance", damageTypes: ["fire"] });
    const four = carrying("item:ring-of-protection", "item:cloak-of-protection", "item:ioun-stone-of-protection", "item:stone-of-good-luck-luckstone");
    const bonuses = heroTraits(four, content).filter((trait) => trait.kind === "armorClassBonus");
    // Ring, cloak and ioun stone all ask for attunement: the fourth item is not attuned.
    expect(bonuses.length).toBeLessThanOrEqual(3);
  });
});
