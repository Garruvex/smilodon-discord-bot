import { describe, expect, it } from "vitest";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { armorClassOf, conditionLookup } from "../../../src/domain/campaign/effects/effect-queries.js";
import { spellbookOf } from "../../../src/domain/campaign/character/spell-access.js";
import { srd51GeneratedSpells } from "../../../src/domain/campaign/content/srd-5.1/spells/srd-spells.generated.js";
import type { ContentId } from "../../../src/domain/campaign/rules/content-id.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { organizer, partyOfThree, ruleset, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

const { content } = ruleset();

function withSpells(spells: readonly ContentId<"spell">[], slots: Readonly<Record<number, number>>): CampaignState {
  const base = partyOfThree();
  const elspeth = base.characters["c-elspeth"];
  if (elspeth === undefined || elspeth.spellcasting === null) throw new Error("fixture");
  const characters = { ...base.characters, "c-elspeth": { ...elspeth, spellcasting: { ...elspeth.spellcasting, spells: [...elspeth.spellcasting.spells, ...spells] } } };
  const heroStatus = { ...base.heroStatus, "c-elspeth": { hp: elspeth.maxHp, resources: { spellSlots: slots, featureUses: {} } } };
  return { ...base, characters, heroStatus };
}

const started = (state: CampaignState): Fight => new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });

describe("the SRD spell roster", () => {
  it.each(srd51GeneratedSpells.map((spell) => spell.id))("%s is named in both languages and plans at every slot level", (id) => {
    expect(enSrd51Glossary.names[id], "en").toBeTruthy();
    expect(zhTwSrd51Glossary.names[id], "zh-TW").toBeTruthy();
    const spell = content.get(id);
    for (let slotLevel = Math.max(1, spell.level); slotLevel <= 9; slotLevel += 1) {
      const plan = spell.plan({ slotLevel: spell.level === 0 ? 0 : slotLevel, casterLevel: 5, spellcastingModifier: 3 });
      expect(plan.onLand).toBeDefined();
    }
    expect(spell.targeting.count).toBeGreaterThanOrEqual(1);
  });

  it("gives a wizard the spells their slots reach, and no higher", () => {
    const wizard = (level: number): Parameters<typeof spellbookOf>[0] => ({ ...partyOfThree().characters["c-elspeth"]!, className: "wizard", level, classLevels: { wizard: level }, spellcasting: { ability: "int" as const, spells: [], slots: {} } });
    const low = spellbookOf(wizard(1), content);
    expect(low).toContain("spell:burning-hands");
    expect(low).toContain("spell:fire-bolt");
    expect(low).not.toContain("spell:fireball");
    const mid = spellbookOf(wizard(5), content);
    expect(mid).toContain("spell:fireball");
    expect(mid).not.toContain("spell:cone-of-cold");
    expect(spellbookOf(wizard(17), content)).toContain("spell:wish");
  });
});

describe("casting the generated spells in a fight", () => {
  it("takes full damage from a failed save and half from a successful one", () => {
    // Shatter, three d8 all threes: nine damage. The first goblin fails its save, the second makes it.
    const fight = started(withSpells(["spell:shatter"], { 2: 1 })).rolls([1, 20], [3, 3, 3]);
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:shatter", slotLevel: 2, targetIds: ["goblin-a", "goblin-b"] });
    expect(fight.combatant("goblin-a").condition).toBe("dead");
    expect(fight.combatant("goblin-b").hp).toBe(3);
  });

  it("raises armor class with Mage Armor", () => {
    const fight = started(withSpells(["spell:mage-armor"], { 1: 2 }));
    const lookup = conditionLookup(content);
    const before = armorClassOf(fight.combatant("c-elspeth"), lookup);
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:mage-armor", slotLevel: 1, targetIds: ["c-elspeth"] });
    const effects = fight.combatant("c-elspeth").effects;
    expect(effects.map((effect) => effect.definition)).toEqual(["spell:mage-armor"]);
    expect(armorClassOf(fight.combatant("c-elspeth"), lookup)).toBe(before + 3);
  });

  it("holds a creature with a condition that ends with the caster's concentration", () => {
    const fight = started(withSpells(["spell:hold-person"], { 2: 1 })).rolls([1]);
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:hold-person", slotLevel: 2, targetIds: ["goblin-a"] });
    const held = fight.combatant("goblin-a").effects.find((effect) => effect.definition === "condition:paralyzed");
    expect(held?.concentrationId).toBe(fight.combatant("c-elspeth").concentration?.resolutionId);
  });

  it("refuses a spell that takes an hour or a reaction on a turn", () => {
    const fight = started(withSpells(["spell:raise-dead", "spell:counterspell"], { 3: 1, 5: 1 }));
    expect(fight.reject(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:raise-dead", slotLevel: 5, targetIds: ["c-mira"] })).toEqual({ code: "unknownSpell" });
    expect(fight.reject(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:counterspell", slotLevel: 3, targetIds: ["goblin-a"] })).toEqual({ code: "unknownSpell" });
  });
});
