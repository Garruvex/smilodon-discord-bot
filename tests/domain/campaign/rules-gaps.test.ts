import { describe, expect, it } from "vitest";

import { carriedWeight, loadOf } from "../../../src/domain/campaign/character/encumbrance.js";
import { passivePerception } from "../../../src/domain/campaign/character/character-sheet.js";
import { SeededRandomSource } from "../../../src/application/campaign/random/seeded-random-source.js";
import { performRoll } from "../../../src/domain/campaign/dice/roll-spec.js";
import { firedEffects } from "../../../src/domain/campaign/engine/round-plan.js";
import type { CampaignState, CheckState, PendingEnvironmentalDamage, RoundState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, borin, jamie, mira, newCampaign, organizer, partyOfThree, reject, run, sam, system, type Step } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// The gaps the SRD checklist listed: knocking a foe out, Ready, damage between fights, group checks, passive Perception and load.

describe("knocking a creature out", () => {
  const goblin = { monsterId: "monster:goblin", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null } as const;

  function strike(nonlethal: boolean): Fight {
    const fight = new Fight(partyOfThree()).rolls([5, 20, 4, 3]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, partyZoneId: "courtyard", monsters: [goblin] } });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin" });
    return fight.rolls([15], [8, 8, 8]).run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin", weapon: "item:longsword", ...(nonlethal ? { nonlethal: true as const } : {}) });
  }

  it("leaves the foe alive and unconscious, and the fight is won", () => {
    const fight = strike(true);
    expect(fight.combatant("goblin").condition).toBe("stable");
    expect(fight.combatant("goblin").hp).toBe(0);
    expect(fight.encounter.status).toBe("ended");
    expect(fight.events.some((event) => event.kind === "encounterEnded" && event.outcome === "victory")).toBe(true);
    expect(fight.events.some((event) => event.kind === "experienceAwarded")).toBe(true);
  });

  it("kills it when the blow is not nonlethal", () => {
    expect(strike(false).combatant("goblin").condition).toBe("dead");
  });
});

describe("Ready", () => {
  const ogre = { monsterId: "monster:ogre", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null } as const;

  it("strikes the first foe that attacks, with the hero's reaction, and is spent", () => {
    const base = partyOfThree();
    const sheet = base.characters["c-borin"];
    if (sheet === undefined) throw new Error("borin");
    const state: CampaignState = { ...base, characters: { ...base.characters, "c-borin": { ...sheet, features: [...sheet.features, "feature:ready"] as typeof sheet.features } } };
    const fight = new Fight(state).rolls([10, 20, 4, 3]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, partyZoneId: "courtyard", monsters: [ogre] } });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "ogre" });
    fight.run(jamie, { kind: "combatCast", combatantId: "c-borin", spellId: "spell:ready", slotLevel: 0, targetIds: ["c-borin"] });
    expect(fight.combatant("c-borin").effects.some((effect) => effect.definition === "condition:readied" || effect.conditions.includes("condition:readied"))).toBe(true);
    fight.run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    fight.run(alex, { kind: "endTurn", combatantId: "c-mira" });
    fight.rolls([19, 15], Array.from({ length: 12 }, () => 1)).run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    const struck = fight.events.some((event) => event.kind === "resolutionDeclared" && event.resolution.actorId === "c-borin" && event.resolution.purpose === "reaction");
    expect(struck).toBe(true);
    expect(fight.combatant("ogre").hp).toBeLessThan(fight.combatant("ogre").maxHp);
    expect(fight.combatant("c-borin").effects.some((effect) => effect.conditions.includes("condition:readied"))).toBe(false);
  });
});

describe("damage between fights", () => {
  const fallOf = (feet: number, seed = 1): { readonly asked: Step; readonly pending: PendingEnvironmentalDamage; readonly settled: Step } => {
    const asked = run(newCampaign(), organizer, { kind: "takeEnvironmentalDamage", characterId: "c-borin", source: { kind: "fall", feet } });
    const pending = asked.state.damagePending?.["c-borin"];
    const request = asked.requests.find((candidate) => candidate.kind === "roll");
    if (pending === undefined || request?.kind !== "roll") throw new Error("no roll asked for");
    return { asked, pending, settled: run(asked.state, system, { kind: "recordRoll", rollId: pending.rollId, result: performRoll(request.spec, new SeededRandomSource(seed)) }) };
  };

  it("rolls 1d6 of bludgeoning for each 10 feet fallen, and takes it off the hero", () => {
    const { pending, settled } = fallOf(30);
    expect(pending.expression.terms).toEqual([{ count: 3, sides: 6 }]);
    expect(pending.damageType).toBe("bludgeoning");
    const record = settled.events.find((event) => event.kind === "environmentalDamageSettled");
    if (record?.kind !== "environmentalDamageSettled") throw new Error("not settled");
    expect(record.damage.rolled).toBeGreaterThanOrEqual(3);
    expect(settled.state.heroStatus["c-borin"]?.hp).toBe(Math.max(0, 12 - record.damage.taken));
    expect(settled.state.damagePending?.["c-borin"]).toBeUndefined();
    expect(settled.requests).toContainEqual({ kind: "deliver", delivery: { kind: "environmentalDamage", damageId: record.damage.id } });
  });

  it("caps a fall at 20 dice", () => {
    expect(fallOf(900).pending.expression.terms).toEqual([{ count: 20, sides: 6 }]);
  });

  it("kills a hero whose damage passes their hit points by their maximum", () => {
    const { settled } = fallOf(200);
    expect(settled.state.heroStatus["c-borin"]).toMatchObject({ hp: 0, dead: true });
    expect(settled.state.characters["c-borin"]?.equipment).toEqual([]);
  });

  it("drops a suffocating hero to 0, and kills one already there", () => {
    const first = run(newCampaign(), organizer, { kind: "takeEnvironmentalDamage", characterId: "c-borin", source: { kind: "suffocation" } });
    expect(first.state.heroStatus["c-borin"]?.hp).toBe(0);
    expect(first.state.heroStatus["c-borin"]?.dead).toBeUndefined();
    const second = run(first.state, organizer, { kind: "takeEnvironmentalDamage", characterId: "c-borin", source: { kind: "suffocation" } });
    expect(second.state.heroStatus["c-borin"]?.dead).toBe(true);
  });

  it("is the organizer's to call, and not in a fight", () => {
    expect(reject(newCampaign(), jamie, { kind: "takeEnvironmentalDamage", characterId: "c-borin", source: { kind: "fall", feet: 10 } })).toEqual({ code: "notOrganizer" });
    expect(reject(newCampaign(), organizer, { kind: "takeEnvironmentalDamage", characterId: "c-borin", source: { kind: "fall", feet: 5 } })).toEqual({ code: "invalidHazardDamage" });
  });
});

describe("group checks", () => {
  const check = (id: string, characterId: string, success: boolean): CheckState =>
    ({ id, roundNumber: 1, characterId, result: { success } }) as unknown as CheckState;
  const stateWith = (results: readonly boolean[]): CampaignState => ({
    ...newCampaign(),
    checks: Object.fromEntries(results.map((success, index) => [`check-${index}`, check(`check-${index}`, `c-${index}`, success)])),
  });
  const round = (success: boolean): RoundState => ({ number: 1, effects: [{ effect: { kind: "revealClue", clueId: "clue:x", text: "x" }, when: { kind: "groupCheck", success } }] }) as unknown as RoundState;

  it("succeeds when at least half of the party's checks do", () => {
    expect(firedEffects(stateWith([true, false]), round(true))).toHaveLength(1);
    expect(firedEffects(stateWith([true, false, false]), round(true))).toHaveLength(0);
    expect(firedEffects(stateWith([true, false, false]), round(false))).toHaveLength(1);
  });
});

describe("passive Perception and load", () => {
  it("is 10 plus the Perception modifier", () => {
    const wise = { ...borin, abilityScores: { ...borin.abilityScores, wis: 16 }, skills: { ...borin.skills, perception: "proficient" as const } };
    expect(passivePerception(wise)).toBe(10 + 3 + wise.proficiencyBonus);
    expect(passivePerception({ ...mira, abilityScores: { ...mira.abilityScores, wis: 10 }, skills: {} })).toBe(10);
  });

  it("weighs what a hero carries against fifteen pounds a point of Strength", () => {
    const loaded = { ...borin, abilityScores: { ...borin.abilityScores, str: 10 }, equipment: ["item:chain-mail", "item:longsword"] as typeof borin.equipment };
    expect(carriedWeight(loaded)).toBe(55 + 3);
    expect(loadOf(loaded)).toMatchObject({ capacity: 150, band: "encumbered", speedPenalty: 10 });
    expect(loadOf({ ...loaded, equipment: [] })).toMatchObject({ carried: 0, band: "light" });
  });
});
