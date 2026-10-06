import { describe, expect, it } from "vitest";

import { buildSpellFacts } from "../../../src/application/campaign/views/spell-facts.js";
import { ruleset } from "../../domain/campaign/campaign-fixtures.js";
import type { SpellDefinition } from "../../../src/domain/campaign/rules/content-definitions.js";

// What the rules book says about a spell is read from the engine's own definition.
const glossary = { language: "en", names: { "spell:fireball": "Fireball", "spell:fire-bolt": "Fire Bolt", "spell:cure-wounds": "Cure Wounds" } };
const facts = (id: string) => buildSpellFacts(ruleset().content.find(id) as SpellDefinition, glossary);

describe("spell facts", () => {
  it("reads Fireball as an area save for 8d6 fire, half on a save, stronger with a higher slot", () => {
    const fireball = facts("spell:fireball");
    expect(fireball).toMatchObject({ name: "Fireball", level: 3, school: "evocation", check: "dex", area: true, scales: true });
    expect(fireball.effects).toEqual([{ kind: "damage", dice: "8d6", damageType: "fire", half: true }]);
  });

  it("reads a cantrip as growing with the caster's level", () => {
    expect(facts("spell:fire-bolt")).toMatchObject({ level: 0, check: "attack", scales: true });
  });

  it("notes when the spellcasting modifier is added", () => {
    expect(facts("spell:cure-wounds")).toMatchObject({ addsModifier: true });
  });
});
