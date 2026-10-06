import { describe, expect, it } from "vitest";
import { foeCards } from "../../../src/application/campaign/dm/scene-cards.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import type { Combatant } from "../../../src/domain/campaign/combat/combat-state.js";
import { monsterCombatant } from "../../../src/domain/campaign/combat/combatant-profile.js";
import { ruleset } from "../../domain/campaign/campaign-fixtures.js";

const content = ruleset().content;
const foe = (monsterId: `monster:${string}`, id: string): Combatant => {
  const monster = content.get(monsterId);
  if (monster.kind !== "monster") throw new Error("monster");
  return monsterCombatant(monster, content, { id, letter: null, zoneId: "gate", npcId: null, fleeBelowHpFraction: null });
};

describe("reference cards for the foes in a fight", () => {
  it("writes one card per kind of monster, from the ruleset's own data", () => {
    const cards = foeCards([foe("monster:owlbear", "owlbear-a"), foe("monster:goblin", "goblin-a"), foe("monster:goblin", "goblin-b")], content, enSrd51Glossary.names);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain("Owlbear");
    expect(cards[0]).toContain("makes several attacks in one turn");
    expect(cards.join("\n")).not.toContain("hit points:");
  });

  it("says when a monster has nothing special, and lists a dragon's breath and immunities", () => {
    const [wolf] = foeCards([foe("monster:wolf", "wolf-a")], content, enSrd51Glossary.names);
    expect(wolf).toContain("Wolf");
    const [dragon] = foeCards([foe("monster:red-dragon-wyrmling", "dragon-a")], content, enSrd51Glossary.names);
    expect(dragon).toContain("area attack");
    expect(dragon).toContain("immune to fire damage");
  });
});
