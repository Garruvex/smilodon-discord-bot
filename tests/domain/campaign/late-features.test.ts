import { describe, expect, it } from "vitest";

import { deriveSheet, type BuildChoices } from "../../../src/domain/campaign/character/character-build.js";
import { applyProgression, levelUp, progressionOf, progressionProblems, xpThresholds } from "../../../src/domain/campaign/character/leveling.js";
import { savingThrowModifier, type CharacterSheet } from "../../../src/domain/campaign/character/character-sheet.js";
import { armorClassFrom } from "../../../src/domain/campaign/combat/combatant-profile.js";
import { conditionLookup } from "../../../src/domain/campaign/effects/effect-queries.js";
import { attackMode } from "../../../src/domain/campaign/engine/combat/attack-rules.js";
import type { EncounterSpec } from "../../../src/domain/campaign/commands/campaign-command.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, d20Roll, jamie, newCampaign, organizer, partyOfThree, partyWithSpells, run, ruleset, sam, system } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// Class features from level 6 up that the engine reads.

function withFeatures(state: CampaignState, heroId: string, features: readonly string[]): CampaignState {
  const sheet = state.characters[heroId];
  if (sheet === undefined) throw new Error(heroId);
  return { ...state, characters: { ...state.characters, [heroId]: { ...sheet, features: [...sheet.features, ...features] as typeof sheet.features } } };
}

describe("saving throw proficiencies", () => {
  it("Slippery Mind adds Wisdom saves and Diamond Soul adds them all", () => {
    const mira = withFeatures(newCampaign(), "c-mira", []).characters["c-mira"];
    if (mira === undefined) throw new Error("mira");
    const plain = savingThrowModifier(mira, "wis");
    const slippery = { ...mira, features: [...mira.features, "feature:slippery-mind"] as typeof mira.features };
    expect(mira.savingThrows.includes("wis")).toBe(false);
    expect(savingThrowModifier(slippery, "wis")).toBe(plain + mira.proficiencyBonus);
    expect(savingThrowModifier(slippery, "cha")).toBe(savingThrowModifier(mira, "cha"));
    const diamond = { ...mira, features: [...mira.features, "feature:diamond-soul"] as typeof mira.features };
    expect(savingThrowModifier(diamond, "cha")).toBe(savingThrowModifier(mira, "cha") + (mira.savingThrows.includes("cha") ? 0 : mira.proficiencyBonus));
  });
});

describe("Indomitable Might", () => {
  it("lifts a Strength check total to the Strength score", () => {
    const base = withFeatures(newCampaign(), "c-mira", ["feature:indomitable-might"]);
    const opened = run(base, system, { kind: "openRound" }).state;
    const acted = run(run(opened, alex, { kind: "submitAction", characterId: "c-mira", text: "I heave the gate." }).state, jamie, { kind: "pass", characterId: "c-borin" }).state;
    const planned = run(acted, system, {
      kind: "applyRoundPlan",
      proposal: { roundNumber: 1, actions: [{ characterId: "c-mira", resolution: { kind: "check", test: { kind: "ability", ability: "str" }, dcTier: "hard", rollModeReasons: [] } }] },
    }).state;
    const clicked = run(planned, alex, { kind: "requestRoll", checkId: "r1:c-mira" });
    const spec = clicked.state.checks["r1:c-mira"]?.spec;
    if (spec === undefined) throw new Error("check");
    const strength = base.characters["c-mira"]?.abilityScores.str ?? 0;
    const resolved = run(clicked.state, system, { kind: "recordRoll", rollId: "r1:c-mira:roll", result: { kind: "d20Test", roll: d20Roll(spec.mode, [2], spec.modifier) } });
    expect(resolved.events.find((event) => event.kind === "checkResolved")).toMatchObject({ result: { roll: { total: strength } } });
  });
});

describe("Survivor", () => {
  it("heals a bloodied fighter as their turn begins", () => {
    const base = withFeatures(newCampaign(), "c-borin", ["feature:survivor"]);
    const state: CampaignState = { ...base, heroStatus: { ...base.heroStatus, "c-borin": { hp: 5, resources: { spellSlots: {}, featureUses: {} } } } };
    const fight = new Fight(state).rolls([1, 20, 5, 4]).run(organizer, { kind: "startEncounter", spec: skirmish });
    // 5 + Constitution modifier (+2), on 5 of 12.
    expect(fight.combatant("c-borin").hp).toBe(12);
  });
});

describe("Elusive", () => {
  function modeAgainst(features: readonly string[]): string {
    const base = withFeatures(newCampaign(), "c-borin", ["feature:reckless-attack", ...features]);
    const fight = new Fight(base).rolls([1, 20, 5, 4]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.run(jamie, { kind: "combatUseFeature", combatantId: "c-borin", featureId: "feature:reckless-attack" });
    const lookup = conditionLookup(ruleset().content);
    return attackMode(fight.encounter, fight.combatant("goblin-a"), fight.combatant("c-borin"), false, false, lookup).mode;
  }

  it("takes advantage away from attacks against the holder", () => {
    expect(modeAgainst([])).toBe("advantage");
    expect(modeAgainst(["feature:elusive"])).toBe("normal");
  });
});

describe("Primal Champion", () => {
  it("raises Strength and Constitution by 4 at barbarian level 20, and survives a saved progression", () => {
    const build: BuildChoices = { class: "barbarian", kit: "berserker", abilities: { str: 15, dex: 12, con: 14, int: 8, wis: 10, cha: 8 }, skills: ["athletics", "perception"], expertise: [], name: "Grok", appearance: "", backstory: "" };
    let sheet = deriveSheet(build);
    for (let level = 2; level <= 20; level += 1) sheet = { ...sheet, ...levelUp(sheet as unknown as CharacterSheet, "barbarian") };
    expect(sheet.abilityScores).toMatchObject({ str: 19, con: 18, dex: 12 });
    expect(sheet.features).toContain("feature:primal-champion");
    const progression = progressionOf({ ...sheet, xp: xpThresholds[19] } as unknown as CharacterSheet);
    expect(progressionProblems(deriveSheet(build), progression)).toEqual([]);
    expect(applyProgression(deriveSheet(build), progression).abilityScores).toMatchObject({ str: 19, con: 18 });
  });
});

describe("Divine Strike, Dark One's Blessing and Potent Cantrip", () => {
  function skirmishWith(heroId: string, features: readonly string[]): Fight {
    return new Fight(withFeatures(partyOfThree(), heroId, features)).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
  }

  it("Divine Strike adds a radiant die to a weapon hit", () => {
    const shoot = (features: readonly string[], dice: readonly number[]): number => {
      const fight = skirmishWith("c-mira", features);
      fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
      fight.rolls([15], dice).run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
      return 7 - fight.combatant("goblin-a").hp;
    };
    const plain = shoot([], [1]);
    expect(shoot(["feature:divine-strike"], [1, 3])).toBe(plain + 3);
  });

  it("Dark One's Blessing gives temporary hit points for a kill", () => {
    const fight = skirmishWith("c-elspeth", ["feature:dark-ones-blessing"]);
    fight.rolls([5], [8]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: ["goblin-a"] });
    expect(fight.combatant("goblin-a").hp).toBe(0);
    // Wisdom modifier 3 plus level 1.
    expect(fight.combatant("c-elspeth").tempHp).toBe(4);
  });

  it("Potent Cantrip halves a damaging cantrip that was saved against", () => {
    const flame = (features: readonly string[], dice: readonly number[]): number => {
      const fight = skirmishWith("c-elspeth", features);
      fight.rolls([15], dice).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: ["goblin-a"] });
      return fight.combatant("goblin-a").hp;
    };
    expect(flame([], [])).toBe(7);
    expect(flame(["feature:potent-cantrip"], [6])).toBe(4);
  });
});

describe("Deflect Missiles", () => {
  it("uses the reaction to turn a ranged hit down", () => {
    const struck = (features: readonly string[]): { readonly lost: number; readonly reaction: boolean } => {
      const state = withFeatures(partyOfThree(), "c-elspeth", features);
      const fight = new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
      fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
      const before = fight.combatant("c-elspeth").hp;
      fight.rolls(Array.from({ length: 6 }, () => 19), Array.from({ length: 6 }, () => 6)).run(alex, { kind: "endTurn", combatantId: "c-mira" });
      return { lost: before - fight.combatant("c-elspeth").hp, reaction: fight.combatant("c-elspeth").budget.reaction };
    };
    const plain = struck([]);
    const deflected = struck(["feature:deflect-missiles"]);
    expect(plain).toMatchObject({ reaction: true });
    expect(plain.lost).toBeGreaterThan(0);
    expect(deflected.reaction).toBe(false);
    expect(deflected.lost).toBeLessThan(plain.lost);
  });
});

describe("Fighting Style: Protection", () => {
  it("spends a neighbor's reaction to give an attack on an ally disadvantage", () => {
    const state = withFeatures(partyOfThree(), "c-borin", ["feature:fighting-style-protection"]);
    const fight = new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    fight.rolls(Array.from({ length: 6 }, () => 10), Array.from({ length: 6 }, () => 3)).run(alex, { kind: "endTurn", combatantId: "c-mira" });
    const shot = fight.events.filter((event) => event.kind === "resolutionDeclared").at(-1);
    expect(shot?.resolution.targetIds).toEqual(["c-elspeth"]);
    expect(Object.values(shot?.resolution.checks ?? {})[0]?.spec.mode).toBe("disadvantage");
    expect(fight.events).toContainEqual({ kind: "uncannyDodgeUsed", combatantId: "c-borin" });
  });
});

describe("Aura of Courage", () => {
  function afterDragon(features: readonly string[]): readonly string[] {
    const spec: EncounterSpec = { ...skirmish, monsters: [{ monsterId: "monster:adult-blue-dragon", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null }] };
    const fight = new Fight(withFeatures(partyOfThree(), "c-elspeth", features)).rolls([20, 1, 1, 1], []).run(organizer, { kind: "startEncounter", spec });
    fight.rolls(Array.from({ length: 30 }, () => 2), Array.from({ length: 30 }, () => 1));
    fight.run(alex, { kind: "endTurn", combatantId: "c-mira" });
    fight.run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    return fight.combatant("c-borin").effects.map((effect) => effect.definition);
  }

  it("keeps the paladin's allies in the same zone from being frightened", () => {
    expect(afterDragon([])).toContain("condition:frightened");
    expect(afterDragon(["feature:aura-of-courage"])).not.toContain("condition:frightened");
  });
});

describe("Cutting Words", () => {
  function shotAtElspeth(features: readonly string[]): { readonly lost: number; readonly spent: boolean } {
    const fight = new Fight(withFeatures(partyOfThree(), "c-elspeth", features)).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    const before = fight.combatant("c-elspeth").hp;
    // 14 + 4 is exactly Elspeth's armor class; the inspiration die takes the average off.
    fight.rolls([14, ...Array.from({ length: 5 }, () => 2)], Array.from({ length: 6 }, () => 3)).run(alex, { kind: "endTurn", combatantId: "c-mira" });
    return { lost: before - fight.combatant("c-elspeth").hp, spent: fight.events.some((event) => event.kind === "uncannyDodgeUsed" && event.combatantId === "c-elspeth") };
  }

  it("turns a hit into a miss by spending a Bardic Inspiration use and the reaction", () => {
    expect(shotAtElspeth(["feature:bardic-inspiration"]).lost).toBeGreaterThan(0);
    expect(shotAtElspeth(["feature:bardic-inspiration", "feature:cutting-words"])).toEqual({ lost: 0, spent: true });
  });
});

describe("Empowered Evocation, Overchannel and Supreme Healing", () => {
  const start = (features: readonly string[], hp?: number): Fight => {
    const base = withFeatures(partyOfThree(), "c-elspeth", features);
    const state: CampaignState = hp === undefined ? base : { ...base, heroStatus: { ...base.heroStatus, "c-borin": { hp, resources: { spellSlots: {}, featureUses: {} } } } };
    return new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
  };

  it("Empowered Evocation adds the spellcasting modifier to an evocation spell's damage", () => {
    const flame = (features: readonly string[]): number => {
      const fight = start(features);
      fight.rolls([5], [2]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: ["goblin-a"] });
      return 7 - fight.combatant("goblin-a").hp;
    };
    expect(flame([])).toBe(2);
    expect(flame(["feature:empowered-evocation"])).toBe(5);
  });

  it("Overchannel makes the next spell deal its maximum damage, once", () => {
    const fight = start(["feature:overchannel"]);
    fight.run(sam, { kind: "combatUseFeature", combatantId: "c-elspeth", featureId: "feature:overchannel" });
    fight.rolls([15]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:guiding-bolt", slotLevel: 1, targetIds: ["goblin-a"] });
    // 4d6 at its most is 24: the goblin is gone without a single die being rolled.
    expect(fight.combatant("goblin-a").hp).toBe(0);
    expect(fight.combatant("c-elspeth").effects.some((effect) => effect.modifiers.some((modifier) => modifier.kind === "overchannel"))).toBe(false);
  });

  it("Supreme Healing restores the most a healing spell's dice can give", () => {
    const heal = (features: readonly string[]): number => {
      const fight = start(features, 2);
      fight.rolls([], [1]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:cure-wounds", slotLevel: 1, targetIds: ["c-borin"] });
      return fight.combatant("c-borin").hp;
    };
    expect(heal(["feature:supreme-healing"])).toBeGreaterThan(heal([]));
  });
});

describe("Short rest features", () => {
  it("Song of Rest heals one more die for a hero who spent a Hit Die", () => {
    const wounded = (features: readonly string[]): number => {
      const base = withFeatures(partyOfThree(), "c-elspeth", features);
      const state: CampaignState = { ...base, heroStatus: { ...base.heroStatus, "c-borin": { hp: 1, resources: { spellSlots: {}, featureUses: {} } } } };
      const rested = run(state, organizer, { kind: "takeRest", rest: "short" }).state;
      return rested.heroStatus["c-borin"]?.hp ?? 0;
    };
    // Borin's Hit Die heals 8; the song adds a d6's average of 4 (capped at his 12).
    expect(wounded([])).toBe(9);
    expect(wounded(["feature:song-of-rest"])).toBe(12);
  });

  it("Sorcerous Restoration returns four sorcery points", () => {
    const base = withFeatures(partyOfThree(), "c-elspeth", ["feature:font-of-magic", "feature:sorcerous-restoration"]);
    const sheet = base.characters["c-elspeth"];
    if (sheet === undefined) throw new Error("elspeth");
    const state: CampaignState = { ...base, characters: { ...base.characters, "c-elspeth": { ...sheet, level: 6 } }, heroStatus: { ...base.heroStatus, "c-elspeth": { hp: 9, resources: { spellSlots: {}, featureUses: { "feature:font-of-magic": 1 } } } } };
    const rested = run(state, organizer, { kind: "takeRest", rest: "short" }).state;
    expect(rested.heroStatus["c-elspeth"]?.resources.featureUses["feature:font-of-magic"]).toBe(5);
  });
});

describe("Feature abilities cast like spells", () => {
  it("Wholeness of Body heals three times the monk's level, once", () => {
    const base = withFeatures(partyOfThree(), "c-borin", ["feature:wholeness-of-body"]);
    const sheet = base.characters["c-borin"];
    if (sheet === undefined) throw new Error("borin");
    const state: CampaignState = { ...base, characters: { ...base.characters, "c-borin": { ...sheet, level: 6, maxHp: 40 } }, heroStatus: { ...base.heroStatus, "c-borin": { hp: 2, resources: { spellSlots: {}, featureUses: {} } } } };
    const fight = new Fight(state).rolls([1, 20, 5, 4]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.run(jamie, { kind: "combatCast", combatantId: "c-borin", spellId: "spell:wholeness-of-body", slotLevel: 0, targetIds: ["c-borin"] });
    expect(fight.combatant("c-borin").hp).toBe(20);
  });

  it("Intimidating Presence frightens a creature that fails its Wisdom save", () => {
    const state = withFeatures(partyOfThree(), "c-borin", ["feature:intimidating-presence"]);
    const fight = new Fight(state).rolls([1, 20, 5, 4]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, edges: [{ from: "gate", to: "courtyard", feet: 10 }] } });
    fight.rolls([2]).run(jamie, { kind: "combatCast", combatantId: "c-borin", spellId: "spell:intimidating-presence", slotLevel: 0, targetIds: ["goblin-a"] });
    expect(fight.combatant("goblin-a").effects.map((effect) => effect.definition)).toContain("condition:frightened");
    expect(fight.reject(jamie, { kind: "combatCast", combatantId: "c-borin", spellId: "spell:intimidating-presence", slotLevel: 0, targetIds: ["goblin-b"] })).toEqual({ code: "noUsesLeft" });
  });
});

describe("Mindless Rage", () => {
  it("keeps a raging barbarian from being frightened", () => {
    const afterDragon = (rage: boolean): readonly string[] => {
      const base = withFeatures(partyOfThree(), "c-borin", ["feature:rage"]);
      const sheet = base.characters["c-borin"];
      if (sheet === undefined) throw new Error("borin");
      const state: CampaignState = { ...base, characters: { ...base.characters, "c-borin": { ...sheet, level: 6 } } };
      const spec: EncounterSpec = { ...skirmish, monsters: [{ monsterId: "monster:adult-blue-dragon", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null }] };
      const fight = new Fight(state).rolls([20, 1, 1, 1], []).run(organizer, { kind: "startEncounter", spec });
      fight.rolls(Array.from({ length: 30 }, () => 2), Array.from({ length: 30 }, () => 1));
      fight.run(alex, { kind: "endTurn", combatantId: "c-mira" });
      if (rage) fight.run(jamie, { kind: "combatUseFeature", combatantId: "c-borin", featureId: "feature:rage" });
      fight.run(jamie, { kind: "endTurn", combatantId: "c-borin" });
      fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
      return fight.combatant("c-borin").effects.map((effect) => effect.definition);
    };
    expect(afterDragon(false)).toContain("condition:frightened");
    expect(afterDragon(true)).not.toContain("condition:frightened");
  });
});

describe("Draconic Bloodline", () => {
  const build: BuildChoices = { class: "sorcerer", kit: "spellslinger", abilities: { str: 8, dex: 14, con: 14, int: 10, wis: 10, cha: 15 }, skills: ["arcana", "persuasion"], expertise: [], name: "Vex", appearance: "", backstory: "" };

  it("adds a hit point a level and an unarmored armor class of 13 plus Dexterity", () => {
    const sheet = deriveSheet(build);
    // d6 + Constitution +2, and one more for Draconic Resilience.
    expect(sheet.maxHp).toBe(9);
    expect(levelUp(sheet as unknown as CharacterSheet, "sorcerer").maxHp).toBe(9 + 4 + 2 + 1);
    expect(armorClassFrom([{ kind: "unarmoredBonus", amount: 3 }], 2)).toBe(15);
  });

  it("Elemental Affinity adds the spellcasting modifier to a fire spell's damage", () => {
    const burn = (features: readonly string[]): number => {
      const base = partyWithSpells(["spell:fire-bolt"]);
      const state = withFeatures(base, "c-elspeth", features);
      const fight = new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
      fight.rolls([15], [2]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:fire-bolt", slotLevel: 0, targetIds: ["goblin-a"] });
      return 7 - fight.combatant("goblin-a").hp;
    };
    expect(burn(["feature:elemental-affinity"])).toBe(burn([]) + 3);
  });
});

describe("Monster traits", () => {
  const seen = (traits: readonly { readonly kind: string }[], lighting?: "bright" | "dim" | "dark", wounded = false): string => {
    const spec: EncounterSpec = { ...skirmish, zones: skirmish.zones.map((zone) => (lighting === undefined ? zone : { ...zone, lighting })) };
    const fight = new Fight(partyOfThree()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec });
    const goblin = { ...fight.combatant("goblin-a"), traits: [...fight.combatant("goblin-a").traits, ...traits] } as ReturnType<Fight["combatant"]>;
    const mira = { ...fight.combatant("c-mira"), ...(wounded ? { hp: 3 } : {}), zoneId: "courtyard" };
    return attackMode(fight.encounter, goblin, mira, false, false, conditionLookup(ruleset().content)).mode;
  };

  it("Blood Frenzy gives advantage against a wounded creature only", () => {
    expect(seen([{ kind: "bloodFrenzy" }], undefined, true)).toBe("advantage");
    expect(seen([{ kind: "bloodFrenzy" }], undefined, false)).toBe("normal");
  });

  it("Sunlight Sensitivity gives disadvantage in a zone lit as bright, and nowhere else", () => {
    expect(seen([{ kind: "sunlightSensitivity" }], "bright")).toBe("disadvantage");
    expect(seen([{ kind: "sunlightSensitivity" }], "dim")).toBe("normal");
    expect(seen([{ kind: "sunlightSensitivity" }])).toBe("normal");
  });

  it("Magic Resistance is played as advantage on saves against spells", () => {
    const traits = ruleset().content.get("monster:balor").traits;
    expect(traits).toContainEqual({ kind: "saveAdvantage", magic: true });
  });
});

describe("Late features that act like spells or reactions", () => {
  it("Stroke of Luck turns a miss into a hit, once", () => {
    const base = withFeatures(partyOfThree(), "c-mira", ["feature:stroke-of-luck"]);
    const state: CampaignState = { ...base, heroStatus: { ...base.heroStatus, "c-mira": { hp: 9, resources: { spellSlots: {}, featureUses: { "feature:stroke-of-luck": 1 } } } } };
    const fight = new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    fight.rolls([2], [3]).run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    expect(fight.combatant("goblin-a").hp).toBeLessThan(7);
    expect(fight.combatant("c-mira").resources.featureUses["feature:stroke-of-luck"]).toBe(0);
  });

  it("Blessed Healer heals the caster when a spell heals someone else", () => {
    const base = withFeatures(partyOfThree(), "c-elspeth", ["feature:blessed-healer"]);
    const status = (hp: number): CampaignState["heroStatus"][string] => ({ hp, resources: { spellSlots: { 1: 2 }, featureUses: {} } });
    const state: CampaignState = { ...base, heroStatus: { ...base.heroStatus, "c-elspeth": status(3), "c-borin": status(2) } };
    const fight = new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.rolls([], [1]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:cure-wounds", slotLevel: 1, targetIds: ["c-borin"] });
    // 2 plus the spell's level 1.
    expect(fight.combatant("c-elspeth").hp).toBe(6);
  });

  it("Mystic Arcanum casts a fixed high spell once", () => {
    const fight = new Fight(withFeatures(partyOfThree(), "c-elspeth", ["feature:mystic-arcanum-9"])).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, edges: [{ from: "gate", to: "courtyard", feet: 10 }] } });
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:power-word-kill", slotLevel: 9, targetIds: ["goblin-a"] });
    expect(fight.combatant("goblin-a").hp).toBe(0);
    expect(fight.combatant("c-elspeth").resources.featureUses["innate:spell:power-word-kill"]).toBe(0);
  });

  it("Holy Nimbus burns each foe as its turn starts", () => {
    const fight = new Fight(withFeatures(partyOfThree(), "c-elspeth", ["feature:holy-nimbus"])).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, edges: [{ from: "gate", to: "courtyard", feet: 10 }] } });
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:holy-nimbus", slotLevel: 0, targetIds: ["goblin-a"] });
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    fight.rolls(Array.from({ length: 6 }, () => 1), Array.from({ length: 6 }, () => 1)).run(alex, { kind: "endTurn", combatantId: "c-mira" });
    expect(fight.combatant("goblin-a").hp).toBe(0);
    expect(fight.combatant("goblin-b").hp).toBe(7);
  });

  it("Fast Hands makes drinking a potion a bonus action", () => {
    const base = withFeatures(partyOfThree(), "c-borin", ["feature:fast-hands"]);
    const borin = base.characters["c-borin"];
    if (borin === undefined) throw new Error("borin");
    const state: CampaignState = { ...base, characters: { ...base.characters, "c-borin": { ...borin, equipment: [...borin.equipment, "item:potion-of-healing" as const] } }, heroStatus: { ...base.heroStatus, "c-borin": { hp: 2, resources: { spellSlots: {}, featureUses: {} } } } };
    const fight = new Fight(state).rolls([1, 20, 5, 4]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.rolls([], [2, 2]).run(jamie, { kind: "combatUseItem", combatantId: "c-borin", itemId: "item:potion-of-healing" });
    expect(fight.combatant("c-borin").budget).toMatchObject({ bonusAction: false, action: true });
  });
});

describe("Ranger and druid capstones", () => {
  it("Foe Slayer adds the Wisdom modifier to a weapon hit", () => {
    const hit = (features: readonly string[]): number => {
      const fight = new Fight(withFeatures(partyOfThree(), "c-elspeth", features)).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, partyZoneId: "courtyard" } });
      fight.run(sam, { kind: "combatEngage", combatantId: "c-elspeth", targetId: "goblin-a" });
      fight.rolls([15], [1]).run(sam, { kind: "combatAttack", combatantId: "c-elspeth", targetId: "goblin-a", weapon: "item:mace" });
      return 7 - fight.combatant("goblin-a").hp;
    };
    // Elspeth's spellcasting modifier is her Wisdom modifier, +3.
    expect(hit(["feature:foe-slayer"])).toBe(hit([]) + 3);
  });
});

describe("A dragon's Wing Attack", () => {
  it("is a legendary action that knocks nearby creatures prone", () => {
    const spec: EncounterSpec = { ...skirmish, partyZoneId: "courtyard", monsters: [{ monsterId: "monster:adult-red-dragon", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null }] };
    const fight = new Fight(partyOfThree()).rolls([20, 1, 1, 1], []).run(organizer, { kind: "startEncounter", spec });
    expect(fight.combatant("adult-red-dragon").traits.some((trait) => trait.kind === "areaAttack" && trait.legendary === true)).toBe(true);
    fight.rolls(Array.from({ length: 12 }, () => 2), Array.from({ length: 12 }, () => 3));
    fight.run(alex, { kind: "combatEngage", combatantId: "c-mira", targetId: "adult-red-dragon" });
    fight.run(alex, { kind: "endTurn", combatantId: "c-mira" });
    const declared = fight.events.filter((event) => event.kind === "resolutionDeclared" && event.resolution.purpose === "legendary");
    expect(declared.length).toBeGreaterThan(0);
    expect(fight.combatant("c-mira").effects.map((effect) => effect.definition)).toContain("condition:prone");
  });
});

describe("Charge", () => {
  const run = (edge: number): { readonly lost: number; readonly prone: boolean } => {
    const spec: EncounterSpec = { ...skirmish, edges: [{ from: "gate", to: "courtyard", feet: edge }], monsters: [{ monsterId: "monster:boar", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null }] };
    // The boar goes first: it hits (19), the target's save fails (2), and every die rolls a 3.
    const fight = new Fight(partyOfThree()).rolls([1, 1, 1, 20, 19, 2], Array.from({ length: 6 }, () => 3)).run(organizer, { kind: "startEncounter", spec });
    const heroes = ["c-mira", "c-borin", "c-elspeth"].map((id) => fight.combatant(id));
    return { lost: 9 + 12 + 9 - heroes.reduce((sum, hero) => sum + hero.hp, 0), prone: heroes.some((hero) => hero.effects.some((effect) => effect.definition === "condition:prone")) };
  };

  it("adds damage and a fall to a hit made after a run at the target, and not to one made without it", () => {
    const charged = run(20);
    const walked = run(5);
    expect(charged.prone).toBe(true);
    expect(walked.prone).toBe(false);
    expect(charged.lost).toBeGreaterThan(walked.lost);
  });
});

describe("Halfling Lucky on an ability check", () => {
  function clickedCheck(): ReturnType<typeof run> {
    const mira = newCampaign().characters["c-mira"];
    if (mira === undefined) throw new Error("mira");
    const base: CampaignState = { ...newCampaign(), characters: { ...newCampaign().characters, "c-mira": { ...mira, race: "race:lightfoot-halfling" } } };
    const opened = run(base, system, { kind: "openRound" }).state;
    const acted = run(run(opened, alex, { kind: "submitAction", characterId: "c-mira", text: "I pick the lock." }).state, jamie, { kind: "pass", characterId: "c-borin" }).state;
    const planned = run(acted, system, {
      kind: "applyRoundPlan",
      proposal: { roundNumber: 1, actions: [{ characterId: "c-mira", resolution: { kind: "check", test: { kind: "ability", ability: "dex" }, dcTier: "hard", rollModeReasons: [] } }] },
    }).state;
    return run(planned, alex, { kind: "requestRoll", checkId: "r1:c-mira" });
  }

  it("rolls a natural 1 again, once, and the second roll stands", () => {
    const clicked = clickedCheck();
    const spec = clicked.state.checks["r1:c-mira"]?.spec;
    if (spec === undefined) throw new Error("check");
    const first = run(clicked.state, system, { kind: "recordRoll", rollId: "r1:c-mira:roll", result: { kind: "d20Test", roll: d20Roll(spec.mode, [1], spec.modifier) } });
    expect(first.events.some((event) => event.kind === "checkResolved")).toBe(false);
    expect(first.requests).toContainEqual(expect.objectContaining({ kind: "roll", rollId: "r1:c-mira:roll:lucky" }));
    const second = run(first.state, system, { kind: "recordRoll", rollId: "r1:c-mira:roll:lucky", result: { kind: "d20Test", roll: d20Roll(spec.mode, [1], spec.modifier) } });
    expect(second.events.find((event) => event.kind === "checkResolved")).toMatchObject({ result: { roll: { d20: { natural: 1 } } } });
  });
});
