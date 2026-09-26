import { describe, expect, it } from "vitest";

import type { Actor, CampaignCommand, EncounterSpec } from "../../../src/domain/campaign/commands/campaign-command.js";
import type { Combatant, EncounterState } from "../../../src/domain/campaign/combat/combat-state.js";
import { heroAttackOption } from "../../../src/domain/campaign/combat/combatant-profile.js";
import { multiplyDice } from "../../../src/domain/campaign/dice/dice-expression.js";
import type { RollResult, RollSpec } from "../../../src/domain/campaign/dice/roll-spec.js";
import { decide } from "../../../src/domain/campaign/engine/decide.js";
import type { EngineRequest } from "../../../src/domain/campaign/engine/engine-request.js";
import type { Rejection } from "../../../src/domain/campaign/engine/rejection.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import { replay } from "../../../src/domain/campaign/events/evolve.js";
import type { WeaponDefinition } from "../../../src/domain/campaign/rules/content-definitions.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, borin, jamie, mira, newCampaign, organizer, ruleset, system } from "./campaign-fixtures.js";

const content = ruleset().content;

// Gate and courtyard 20 ft apart: a hero can cross and engage (20 + 10 = 30 ft).
const skirmish: EncounterSpec = {
  id: "enc-1",
  zones: [
    { id: "gate", name: "Gate" },
    { id: "courtyard", name: "Courtyard" },
  ],
  edges: [{ from: "gate", to: "courtyard", feet: 20 }],
  partyZoneId: "gate",
  monsters: [
    { monsterId: "monster:goblin", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null },
    { monsterId: "monster:goblin", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null },
  ],
};

// Drives a fight: runs commands, then feeds every roll the engine asks for
// from scripted dice, the way the roll worker would, until play waits for a
// player. Every step is replayed through evolve() to prove they agree.
class Fight {
  public state: CampaignState;
  public readonly events: CampaignEvent[] = [];
  public readonly requests: EngineRequest[] = [];
  private readonly d20s: number[] = [];
  private readonly dice: number[] = [];

  public constructor(state: CampaignState = newCampaign()) {
    this.state = state;
  }

  public rolls(d20s: readonly number[], dice: readonly number[] = []): this {
    this.d20s.push(...d20s);
    this.dice.push(...dice);
    return this;
  }

  public run(actor: Actor, command: CampaignCommand, now = 0): this {
    const pending = this.apply(actor, command, now);
    while (pending.length > 0) {
      const request = pending.shift();
      if (request?.kind !== "roll") continue;
      pending.push(...this.apply(system, { kind: "recordRoll", rollId: request.rollId, result: this.result(request.spec) }, now));
    }
    return this;
  }

  public reject(actor: Actor, command: CampaignCommand): Rejection {
    const result = decide(this.state, command, { rules: ruleset(), now: 0, actor });
    if (result.kind !== "rejected") throw new Error(`Expected ${command.kind} to be rejected.`);
    return result.rejection;
  }

  public get encounter(): EncounterState {
    if (this.state.encounter === null) throw new Error("No encounter.");
    return this.state.encounter;
  }

  public combatant(id: string): Combatant {
    const combatant = this.encounter.combatants[id];
    if (combatant === undefined) throw new Error(`No combatant ${id}.`);
    return combatant;
  }

  public get current(): string | undefined {
    return this.encounter.order[this.encounter.turnIndex];
  }

  public kinds(): readonly string[] {
    return this.events.map((event) => event.kind);
  }

  private apply(actor: Actor, command: CampaignCommand, now: number): EngineRequest[] {
    const result = decide(this.state, command, { rules: ruleset(), now, actor });
    if (result.kind === "rejected") throw new Error(`${command.kind} rejected: ${JSON.stringify(result.rejection)}`);
    this.state = replay(this.state, result.events);
    this.events.push(...result.events);
    this.requests.push(...result.requests);
    return [...result.requests];
  }

  private result(spec: RollSpec): RollResult {
    if (spec.kind === "d20Test") {
      const count = spec.spec.mode === "normal" ? 1 : 2;
      const values = Array.from({ length: count }, () => this.d20s.shift() ?? 10);
      const natural = spec.spec.mode === "advantage" ? Math.max(...values) : Math.min(...values);
      const total = natural + spec.spec.modifier;
      return {
        kind: "d20Test",
        roll: { d20: { mode: spec.spec.mode, values, natural, modifier: spec.spec.modifier, total }, bonusDice: [], total },
      };
    }
    const expression = spec.critical ? multiplyDice(spec.expression, 2) : spec.expression;
    const terms = expression.terms.map((term) => ({ sides: term.sides, values: Array.from({ length: term.count }, () => this.dice.shift() ?? 1) }));
    const total = expression.modifier + terms.reduce((sum, term) => sum + term.values.reduce((a, b) => a + b, 0), 0);
    return { kind: "dice", roll: { expression, terms, modifier: expression.modifier, total } };
  }
}

// Initiative order used by most tests: Mira 20, Borin 15, goblins 5 and 4.
function startedFight(state?: CampaignState): Fight {
  return new Fight(state).rolls([20, 15, 5, 4]).run(organizer, { kind: "startEncounter", spec: skirmish });
}

describe("combat profiles", () => {
  it("derives hero attacks from abilities, proficiency, and weapon properties", () => {
    const weapon = (id: string): WeaponDefinition => content.get(id as `item:${string}`);
    expect(heroAttackOption(mira, weapon("item:shortsword"))).toMatchObject({ toHit: 5, damage: { terms: [{ count: 1, sides: 6 }], modifier: 3 } });
    expect(heroAttackOption(mira, weapon("item:shortbow"))).toMatchObject({ toHit: 5, range: { kind: "ranged", normal: 80, long: 320 } });
    expect(heroAttackOption(borin, weapon("item:longsword"))).toMatchObject({ toHit: 5, damage: { terms: [{ count: 1, sides: 8 }], modifier: 3 } });
  });

  it("gives heroes and monsters the same combatant shape", () => {
    const fight = startedFight();
    const hero = fight.combatant("c-mira");
    const goblin = fight.combatant("goblin-a");
    expect(Object.keys(hero).sort()).toEqual(Object.keys(goblin).sort());
    expect(goblin).toMatchObject({ side: "foes", letter: "A", armorClass: 15, hp: 7, attacks: [{ toHit: 4 }, { toHit: 4 }] });
    expect(hero).toMatchObject({ side: "party", armorClass: 14, hp: 9, tactic: null });
  });
});

describe("starting an encounter", () => {
  it("rolls initiative for everyone and starts the highest roller's turn", () => {
    const fight = startedFight();
    expect(fight.encounter.order).toEqual(["c-mira", "c-borin", "goblin-a", "goblin-b"]);
    expect(fight.encounter.status).toBe("active");
    expect(fight.current).toBe("c-mira");
    expect(fight.combatant("c-mira").budget).toEqual({ action: true, bonusAction: true, reaction: true, movement: 30 });
    expect(fight.requests).toContainEqual({
      kind: "startTimer",
      timer: { kind: "combatTurn", timerId: "turn:enc-1:1", dueAt: 180_000, encounterId: "enc-1", turnNumber: 1 },
    });
  });

  it("validates the encounter and who may start it", () => {
    const fight = new Fight();
    expect(fight.reject(alex, { kind: "startEncounter", spec: skirmish })).toEqual({ code: "notOrganizer" });
    const broken: EncounterSpec = {
      ...skirmish,
      partyZoneId: "moat",
      monsters: [{ monsterId: "monster:dragon", zoneId: "sky", npcId: null, fleeBelowHpFraction: 2 }],
    };
    expect(fight.reject(organizer, { kind: "startEncounter", spec: broken })).toEqual({
      code: "invalidEncounter",
      problems: [
        "Party zone moat does not exist.",
        "Unknown monster monster:dragon.",
        "monster:dragon is placed in unknown zone sky.",
        "monster:dragon flee threshold must be between 0 and 1.",
      ],
    });
  });

  it("holds exploration rounds while a fight is on", () => {
    expect(startedFight().reject(system, { kind: "openRound" })).toEqual({ code: "inCombat" });
  });
});

describe("hero turns", () => {
  it("moves, engages, and pays for movement from the turn budget", () => {
    const fight = startedFight();
    fight.run(alex, { kind: "combatMove", combatantId: "c-mira", zoneId: "courtyard" });
    fight.run(alex, { kind: "combatEngage", combatantId: "c-mira", targetId: "goblin-a" });
    expect(fight.combatant("c-mira")).toMatchObject({ zoneId: "courtyard", budget: { movement: 0 } });
    expect(fight.encounter.engagements).toEqual([["c-mira", "goblin-a"]]);
    expect(fight.reject(alex, { kind: "combatEngage", combatantId: "c-mira", targetId: "goblin-b" })).toEqual({
      code: "notEnoughMovement",
      needed: 10,
      left: 0,
    });
  });

  it("refuses actions out of turn, for someone else's hero, and melee without engagement", () => {
    const fight = startedFight();
    expect(fight.reject(jamie, { kind: "combatDodge", combatantId: "c-borin" })).toEqual({ code: "notYourTurn" });
    expect(fight.reject(jamie, { kind: "combatDodge", combatantId: "c-mira" })).toEqual({ code: "notYourCharacter" });
    expect(fight.reject(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortsword" })).toEqual({
      code: "notEngaged",
    });
    expect(fight.reject(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "c-borin", weapon: "item:shortbow" })).toEqual({
      code: "invalidTarget",
    });
  });

  it("runs the attack sequence: attack roll, then damage on a hit, applied to HP", () => {
    const fight = startedFight().rolls([12], [5]);
    fight.run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    const attackEvents = fight.events.slice(fight.kinds().lastIndexOf("attackDeclared"));
    expect(attackEvents.map((event) => event.kind)).toEqual([
      "attackDeclared",
      "attackRolled",
      "damageRollRequested",
      "damageRolled",
      "combatantHpChanged",
      "attackFinished",
    ]);
    expect(attackEvents[1]).toMatchObject({ hit: true, critical: false, roll: { total: 17 } });
    // 1d6 (5) + 3 = 8 damage kills the 7 HP goblin.
    expect(fight.combatant("goblin-a")).toMatchObject({ hp: 0, condition: "dead" });
    expect(fight.combatant("c-mira").budget.action).toBe(false);
    expect(fight.current).toBe("c-mira");
  });

  it("doubles damage dice on a natural 20 and skips damage on a miss", () => {
    const crit = startedFight().rolls([20], [1, 1]);
    crit.run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    const damage = crit.events.find((event) => event.kind === "damageRolled");
    expect(damage).toMatchObject({ roll: { expression: { terms: [{ count: 2, sides: 6 }], modifier: 3 }, total: 5 } });

    const miss = startedFight().rolls([2]);
    miss.run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    expect(miss.kinds()).not.toContain("damageRollRequested");
    expect(miss.combatant("goblin-a").hp).toBe(7);
  });

  it("gives the Dodge action's disadvantage to attackers until the dodger's next turn", () => {
    const fight = startedFight();
    fight.run(alex, { kind: "combatDodge", combatantId: "c-mira" });
    fight.run(alex, { kind: "endTurn", combatantId: "c-mira" });
    fight.run(jamie, { kind: "combatDodge", combatantId: "c-borin" });
    // Goblins shoot (skirmishers, not engaged); both heroes are dodging.
    fight.rolls([15, 3, 15, 3]).run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    const shots = fight.events.filter((event) => event.kind === "attackDeclared");
    expect(shots.map((event) => event.attack.spec.mode)).toEqual(["disadvantage", "disadvantage"]);
    expect(fight.current).toBe("c-mira");
    expect(fight.combatant("c-mira").dodging).toBe(false);
  });
});

describe("monster tactics", () => {
  it("has skirmishers shoot from range and brutes close in with Pack Tactics", () => {
    const pack: EncounterSpec = {
      ...skirmish,
      monsters: [
        { monsterId: "monster:wolf", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null },
        { monsterId: "monster:wolf", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null },
      ],
    };
    // Wolves act first (initiative 20, 19), heroes after.
    const fight = new Fight().rolls([5, 4, 20, 19]).run(organizer, { kind: "startEncounter", spec: pack });
    const bites = fight.events.filter((event) => event.kind === "attackDeclared");
    expect(bites).toHaveLength(2);
    // Both go for the nearest, most hurt hero (Mira, 9 HP); the second wolf
    // has an engaged ally, so Pack Tactics gives it advantage.
    expect(bites.map((event) => [event.attack.targetId, event.attack.spec.mode])).toEqual([
      ["c-mira", "normal"],
      ["c-mira", "advantage"],
    ]);
    expect(fight.combatant("wolf-a").zoneId).toBe("gate");
  });

  it("dashes toward a hero it cannot reach this turn", () => {
    const far: EncounterSpec = {
      ...skirmish,
      edges: [{ from: "gate", to: "courtyard", feet: 60 }],
      monsters: [{ monsterId: "monster:bugbear", zoneId: "courtyard", npcId: "npc:skarn", fleeBelowHpFraction: null }],
    };
    const fight = new Fight().rolls([5, 4, 20]).run(organizer, { kind: "startEncounter", spec: far });
    expect(fight.events).toContainEqual({ kind: "actionTaken", combatantId: "bugbear", action: "dash" });
    expect(fight.combatant("bugbear")).toMatchObject({ zoneId: "gate", source: { npcId: "npc:skarn" } });
    expect(fight.kinds()).not.toContain("attackDeclared");
  });

  it("flees below its threshold at the start of its turn", () => {
    const leader: EncounterSpec = {
      ...skirmish,
      monsters: [{ monsterId: "monster:bugbear", zoneId: "courtyard", npcId: "npc:skarn", fleeBelowHpFraction: 0.5 }],
    };
    const fight = new Fight().rolls([20, 15, 5]).run(organizer, { kind: "startEncounter", spec: leader });
    // Mira shoots Skarn for 15 (crit 2d6+3: 6 + 6 + 3), leaving 12 of 27.
    fight.rolls([20], [6, 6]).run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "bugbear", weapon: "item:shortbow" });
    fight.run(alex, { kind: "endTurn", combatantId: "c-mira" });
    fight.run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    expect(fight.combatant("bugbear").condition).toBe("fled");
    expect(fight.events.at(-1)).toEqual({ kind: "encounterEnded", outcome: "victory" });
  });
});

describe("dropping, death saves, and the end of a fight", () => {
  // Initiative: goblins 22 and 21, Mira 8, Borin 5. Goblin A crits Mira for
  // (6 + 6) + 2 = 14 and she drops; goblin B rolls a 1 at Borin; then Mira's
  // turn opens with a death save using the given d20.
  function downedMira(deathSave: number): Fight {
    return new Fight().rolls([5, 4, 20, 19, 20, 1, deathSave], [6, 6]).run(organizer, { kind: "startEncounter", spec: skirmish });
  }

  it("knocks a hero unconscious at 0 HP and leaves them alone", () => {
    const fight = downedMira(10);
    expect(fight.combatant("c-mira")).toMatchObject({ hp: 0, condition: "unconscious", deathSaves: { successes: 1, failures: 0 } });
    // The second goblin shoots Borin instead of the downed Mira.
    const shots = fight.events.filter((event) => event.kind === "attackDeclared");
    expect(shots.map((event) => event.attack.targetId)).toEqual(["c-mira", "c-borin"]);
  });

  it("rolls a death save at the start of a downed hero's turn", () => {
    const fight = downedMira(8);
    expect(fight.combatant("c-mira").deathSaves).toEqual({ successes: 0, failures: 1 });
    expect(fight.current).toBe("c-borin");
  });

  it("revives on a natural 20 and gives the turn back", () => {
    const fight = downedMira(20);
    expect(fight.combatant("c-mira")).toMatchObject({ hp: 1, condition: "active" });
    expect(fight.current).toBe("c-mira");
  });

  it("kills outright when leftover damage reaches the hero's maximum", () => {
    // A bugbear beside the party acts first and hits Mira (9 HP) for
    // 8 + 8 + 2 = 18: 9 over, equal to her maximum.
    const tough: EncounterSpec = { ...skirmish, monsters: [{ monsterId: "monster:bugbear", zoneId: "gate", npcId: null, fleeBelowHpFraction: null }] };
    const fight = new Fight().rolls([5, 4, 20, 15], [8, 8]).run(organizer, { kind: "startEncounter", spec: tough });
    const hit = fight.events.find((event) => event.kind === "combatantHpChanged");
    expect(hit).toMatchObject({ combatantId: "c-mira", condition: "dead", cause: "massiveDamage" });
  });

  it("ends in defeat when no hero is left standing", () => {
    // Both goblins crit: Mira takes 14 (of 9) and Borin 14 (of 12); both drop.
    const fight = new Fight().rolls([5, 4, 20, 19, 20, 20], [6, 6, 6, 6]).run(organizer, { kind: "startEncounter", spec: skirmish });
    expect(fight.events.at(-1)).toEqual({ kind: "encounterEnded", outcome: "defeat" });
    expect(fight.state.heroHp).toEqual({ "c-mira": 0, "c-borin": 0 });
  });

  it("ends in victory when every foe is down, and keeps the heroes' HP", () => {
    const fight = startedFight().rolls([15], [6]);
    fight.run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    fight.run(alex, { kind: "endTurn", combatantId: "c-mira" });
    fight.run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-b" });
    fight.rolls([15], [8]).run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-b", weapon: "item:longsword" });
    expect(fight.events.at(-1)).toEqual({ kind: "encounterEnded", outcome: "victory" });
    expect(fight.state.heroHp).toEqual({ "c-mira": 9, "c-borin": 12 });
    fight.run(system, { kind: "openRound" });
    expect(fight.state.round?.number).toBe(1);
  });
});

describe("away heroes and timers", () => {
  it("plays an away hero on cautious autopilot: Dodge when nothing is engaging them", () => {
    const state = newCampaign();
    const away = { ...state, members: { ...state.members, "u-jamie": { ...state.members["u-jamie"]!, availability: "away" as const } } };
    const fight = startedFight(away);
    fight.rolls([2, 2]).run(alex, { kind: "endTurn", combatantId: "c-mira" });
    expect(fight.events).toContainEqual({ kind: "actionTaken", combatantId: "c-borin", action: "dodge" });
  });

  it("applies autopilot when a player's turn timer runs out, once", () => {
    const fight = startedFight().rolls([2, 2]);
    fight.run(system, { kind: "turnTimerExpired", encounterId: "enc-1", turnNumber: 1 });
    expect(fight.events).toContainEqual({ kind: "actionTaken", combatantId: "c-mira", action: "dodge" });
    expect(fight.current).toBe("c-borin");
    // The same timer firing again is stale and changes nothing.
    const before = fight.events.length;
    fight.run(system, { kind: "turnTimerExpired", encounterId: "enc-1", turnNumber: 1 });
    expect(fight.events).toHaveLength(before);
  });

  it("pauses when the table empties and resumes the due turn on continue", () => {
    const fight = startedFight();
    fight.run(jamie, { kind: "markAway", userId: "u-jamie" });
    fight.run(alex, { kind: "markAway", userId: "u-alex" });
    expect(fight.state.status).toBe("waitingForPlayers");
    fight.run(alex, { kind: "markReturned", userId: "u-alex" });
    fight.rolls([2, 2]).run(alex, { kind: "continue" });
    expect(fight.state.status).toBe("active");
    expect(fight.current).toBe("c-mira");
  });
});
