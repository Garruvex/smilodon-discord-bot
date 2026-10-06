import { describe, expect, it } from "vitest";

import { organizer, partyWithSpells, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// An area spell reaches every creature in the zone it is aimed at, friends and the caster included; Careful Spell spares the friends.

const together = { ...skirmish, partyZoneId: "courtyard" };

function start(spells: readonly `spell:${string}`[], features: readonly string[] = []): Fight {
  const base = partyWithSpells(spells, { 3: 1 });
  const elspeth = base.characters["c-elspeth"];
  if (elspeth === undefined) throw new Error("elspeth");
  const withFeatures = { ...base, characters: { ...base.characters, "c-elspeth": { ...elspeth, features: [...elspeth.features, ...features] as typeof elspeth.features, level: 5 } } };
  return new Fight(withFeatures).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: together });
}

describe("an area spell", () => {
  it("hits everyone in the zone, the caster's friends and the caster too", () => {
    const fight = start(["spell:fireball"]);
    // Every save fails (2), and eight d6 come up 3.
    fight.rolls(Array.from({ length: 6 }, () => 2), Array.from({ length: 8 }, () => 3)).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:fireball", slotLevel: 3, targetIds: ["goblin-a"] });
    const hurt = fight.events.filter((event) => event.kind === "combatantHpChanged" && event.change < 0).map((event) => (event.kind === "combatantHpChanged" ? event.combatantId : ""));
    expect(new Set(hurt)).toEqual(new Set(["goblin-a", "goblin-b", "c-mira", "c-borin", "c-elspeth"]));
  });

  it("stays in its zone: a creature elsewhere is not touched", () => {
    const fight = new Fight(partyWithSpells(["spell:fireball"], { 3: 1 })).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.rolls([2, 2], Array.from({ length: 8 }, () => 3)).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:fireball", slotLevel: 3, targetIds: ["goblin-a"] });
    const hurt = new Set(fight.events.flatMap((event) => (event.kind === "combatantHpChanged" && event.change < 0 ? [event.combatantId] : [])));
    expect([...hurt].sort()).toEqual(["goblin-a", "goblin-b"]);
  });

  it("is softened for the friends by Careful Spell, who save without rolling", () => {
    const fight = start(["spell:fireball"], ["feature:font-of-magic", "feature:careful-spell"]);
    fight.run(sam, { kind: "combatUseFeature", combatantId: "c-elspeth", featureId: "feature:careful-spell" });
    // The two goblins and the caster roll and fail; the caster's friends pass without rolling, and take half.
    fight.rolls([2, 2, 2], Array.from({ length: 8 }, () => 3)).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:fireball", slotLevel: 3, targetIds: ["goblin-a"] });
    const damage = (id: string): number => fight.events.reduce((sum, event) => (event.kind === "combatantHpChanged" && event.combatantId === id && event.change < 0 ? sum - event.change : sum), 0);
    expect(damage("goblin-a")).toBe(24);
    expect(damage("c-elspeth")).toBe(24);
    expect(damage("c-borin")).toBe(12);
    expect(damage("c-mira")).toBe(12);
  });
});
