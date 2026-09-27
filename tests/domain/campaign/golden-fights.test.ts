import { describe, expect, it } from "vitest";

import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import { alex, jamie, organizer, partyOfThree, ruleset, sam } from "./campaign-fixtures.js";
import { Fight, skirmish, startedFight } from "./combat-fixtures.js";

// Golden fights (docs/dnd-engine-architecture.md §10, step 1): whole fights
// played by the engine on fixed dice, recorded as a compact trace of what
// happened. A refactor of the combat engine must leave these files unchanged;
// a change to them is a change of behavior and has to be intended and reviewed
// (update with `vitest -u`, then read the diff).

// A small fixed pseudo-random stream, so the dice are the same on every run.
function stream(seed: number): () => number {
  let state = seed;
  return (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

// The parts of an event that show what happened, without the bookkeeping.
function trace(event: CampaignEvent): string {
  const e = event as unknown as Record<string, unknown>;
  const pick = (...keys: string[]): string => keys.filter((key) => e[key] !== undefined).map((key) => `${key}=${JSON.stringify(e[key])}`).join(" ");
  switch (event.kind) {
    case "turnStarted":
      return `turnStarted ${pick("combatantId", "round")}`;
    case "combatantHpChanged":
      return `hp ${pick("combatantId", "hp", "delta")}`;
    case "combatantMoved":
    case "combatantEngaged":
    case "combatantWithdrew":
    case "combatantFled":
    case "stoodUp":
      return `${event.kind} ${pick("combatantId", "zoneId", "feet")}`;
    case "conditionAdded":
    case "effectAdded":
    case "effectsRemoved":
      return `${event.kind} ${pick("combatantId", "condition", "sourceId")}`;
    case "encounterEnded":
      return `encounterEnded ${pick("outcome")}`;
    case "initiativeRolled":
      return `initiative ${pick("combatantId", "total")}`;
    default:
      return event.kind;
  }
}

function play(seed: number): string {
  const random = stream(seed);
  const d20s = Array.from({ length: 300 }, () => 1 + Math.floor(random() * 20));
  const dice = Array.from({ length: 300 }, () => 1 + Math.floor(random() * 4));
  return report(`autopilot seed ${seed}`, new Fight(undefined, ruleset({ "combat-mode": "autopilot" })).rolls(d20s, dice).run(organizer, { kind: "startEncounter", spec: skirmish }));
}

// The result of a played fight: where it ended, how everyone stands, then what happened, in order.
function report(name: string, fight: Fight): string {
  const encounter = fight.encounter;
  const summary = Object.values(encounter.combatants).map((c) => `${c.id}: hp ${c.hp}/${c.maxHp} ${c.condition} zone=${c.zoneId} conditions=[${c.conditions.join(",")}]`);
  return [name, `status ${encounter.status} outcome ${String(encounter.outcome)} round ${encounter.round}`, ...summary, "", ...fight.events.map(trace)].join("\n") + "\n";
}

// Players drive the heroes: a clean win with a shot and a sword.
function victory(): string {
  const fight = startedFight().rolls([15], [6]);
  fight.run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
  fight.run(alex, { kind: "endTurn", combatantId: "c-mira" });
  fight.run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" });
  fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-b" });
  fight.rolls([15], [8]).run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-b", weapon: "item:longsword" });
  return report("scripted victory", fight);
}

// A cleric blesses the party, a shot lands with the die, and a goblin's hit breaks her concentration.
function bless(): string {
  const fight = new Fight(partyOfThree()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
  fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:bless", slotLevel: 1, targetIds: ["c-elspeth", "c-mira", "c-borin"] });
  fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
  fight.rolls([2], [1]).run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
  fight.rolls([15, 3], [3, 1]).run(alex, { kind: "endTurn", combatantId: "c-mira" });
  return report("scripted bless and concentration", fight);
}

describe("golden fights", () => {
  it("plays a scripted victory the same way every time", async () => {
    await expect(victory()).toMatchFileSnapshot("./golden/scripted-victory.txt");
  });

  it("plays a scripted Bless and broken concentration the same way every time", async () => {
    await expect(bless()).toMatchFileSnapshot("./golden/scripted-bless.txt");
  });

  for (const seed of [1, 7, 42]) {
    it(`plays seed ${seed} the same way every time`, async () => {
      const first = play(seed);
      expect(play(seed)).toBe(first);
      await expect(first).toMatchFileSnapshot(`./golden/autopilot-seed-${seed}.txt`);
    });
  }
});
