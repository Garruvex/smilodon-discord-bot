import { describe, expect, it } from "vitest";

import { passivePerception } from "../../../src/domain/campaign/character/character-sheet.js";
import type { EncounterSpec, PartyEffect, PlannedEffect, RoundPlanProposal } from "../../../src/domain/campaign/commands/campaign-command.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, d20Roll, jamie, newCampaign, organizer, partyOfThree, run, system } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// What an adventure can add to a beat: lines for the table, keepsakes, harm, saving throws, and a fight that opens in ambush or dread.

const always = { kind: "always" } as const;

function closedRound(state: CampaignState): CampaignState {
  let next = run(state, system, { kind: "openRound" }).state;
  next = run(next, alex, { kind: "submitAction", characterId: "c-mira", text: "I go on." }).state;
  return run(next, jamie, { kind: "pass", characterId: "c-borin" }).state;
}

// Mira makes a saving throw; the d20 is chosen, the modifier is whatever the engine asked for.
function saveRound(effects: readonly PlannedEffect[], dc: number, d20: number, state: CampaignState = newCampaign()): ReturnType<typeof run> {
  const proposal: RoundPlanProposal = {
    roundNumber: 1,
    actions: [{ characterId: "c-mira", resolution: { kind: "check", test: { kind: "save", ability: "con" }, dcTier: "medium", dc, rollModeReasons: [] } }],
    effects,
  };
  const planned = run(closedRound(state), system, { kind: "applyRoundPlan", proposal }).state;
  const rolling = run(planned, alex, { kind: "requestRoll", checkId: "r1:c-mira" }).state;
  const modifier = rolling.checks["r1:c-mira"]?.spec.modifier ?? 0;
  return run(rolling, system, { kind: "recordRoll", rollId: "r1:c-mira:roll", result: { kind: "d20Test", roll: d20Roll("normal", [d20], modifier) } });
}

const deliveries = (step: ReturnType<typeof run>): readonly unknown[] => step.requests.filter((request) => request.kind === "deliver").map((request) => (request.kind === "deliver" ? request.delivery : null));

describe("lines and keepsakes", () => {
  const notice: PlannedEffect = { effect: { kind: "notice", noticeId: "n1", text: "The wind drops." }, when: always };
  const keepsake: PlannedEffect = { effect: { kind: "grantKeepsake", keepsake: { id: "bent-token", name: "Bent's token", description: "A carved token." } }, when: always };

  it("shows a notice once, however often the beat comes round", () => {
    const first = saveRound([notice], 10, 10);
    expect(deliveries(first)).toContainEqual({ kind: "storyNotice", text: "The wind drops." });
    expect(first.state.flags).toMatchObject({ "notice:n1": 1 });
    const again = saveRound([notice], 10, 10, { ...newCampaign(), flags: { "notice:n1": 1 } });
    expect(deliveries(again)).not.toContainEqual({ kind: "storyNotice", text: "The wind drops." });
  });

  it("gives the party a keepsake once, with the words it is known by", () => {
    const first = saveRound([keepsake], 10, 10);
    expect(first.state.keepsakes).toEqual({ "bent-token": { id: "bent-token", name: "Bent's token", description: "A carved token." } });
    expect(deliveries(first)).toContainEqual({ kind: "keepsakeGained", keepsakeId: "bent-token" });
    const again = saveRound([keepsake], 10, 10, first.state === undefined ? newCampaign() : { ...newCampaign(), keepsakes: first.state.keepsakes ?? {} });
    expect(deliveries(again)).not.toContainEqual({ kind: "keepsakeGained", keepsakeId: "bent-token" });
  });

  it("tells the table about a reward and a payment", () => {
    const step = saveRound(
      [
        { effect: { kind: "grantReward", rewardId: "r-1", gold: 30, items: [] }, when: always },
        { effect: { kind: "spendGold", characterId: "c-mira", amount: 10 }, when: always },
      ],
      10,
      10,
      { ...newCampaign(), gold: 20 },
    );
    expect(deliveries(step)).toContainEqual({ kind: "rewardFound", rewardId: "r-1" });
    expect(deliveries(step)).toContainEqual({ kind: "paymentMade", characterId: "c-mira", amount: 10 });
    expect(step.state.gold).toBe(40);
  });

  it("refuses an empty notice or a keepsake with no words", () => {
    const proposal = (effect: PlannedEffect): RoundPlanProposal => ({ roundNumber: 1, actions: [{ characterId: "c-mira", resolution: { kind: "automatic", reason: "walks" } }], effects: [effect] });
    const round = closedRound(newCampaign());
    for (const effect of [
      { effect: { kind: "notice", noticeId: "n", text: "  " }, when: always },
      { effect: { kind: "grantKeepsake", keepsake: { id: "x", name: "", description: "d" } }, when: always },
    ] as const) {
      expect(() => run(round, system, { kind: "applyRoundPlan", proposal: proposal(effect) })).toThrow(/invalidPlan/);
    }
  });
});

describe("a saving throw and harm from the surroundings", () => {
  const hurt: PlannedEffect = { effect: { kind: "hurt", characterId: "c-mira", count: 2, sides: 6, damageType: "poison" }, when: { kind: "checkOutcome", characterId: "c-mira", success: false } };

  it("rolls the hero's saving throw with their saving bonus and its authored DC", () => {
    const step = saveRound([], 15, 10);
    const check = step.state.checks["r1:c-mira"];
    expect(check).toMatchObject({ dc: 15, test: { kind: "save", ability: "con" } });
    expect(check?.spec.modifier).toBeDefined();
  });

  it("hurts a hero who failed the save, with dice, and spares one who passed", () => {
    const failed = saveRound([hurt], 30, 10);
    const started = failed.events.find((event) => event.kind === "environmentalDamageStarted");
    expect(started).toMatchObject({ pending: { characterId: "c-mira", damageType: "poison", expression: { terms: [{ count: 2, sides: 6 }] } } });
    expect(failed.requests.some((request) => request.kind === "roll")).toBe(true);
    const passed = saveRound([hurt], 1, 15);
    expect(passed.events.some((event) => event.kind === "environmentalDamageStarted")).toBe(false);
  });

  it("refuses harm to someone who is not in the party, and harm out of range", () => {
    const round = closedRound(newCampaign());
    const propose = (effect: PlannedEffect["effect"]): RoundPlanProposal => ({ roundNumber: 1, actions: [{ characterId: "c-mira", resolution: { kind: "automatic", reason: "walks" } }], effects: [{ effect, when: always }] });
    expect(() => run(round, system, { kind: "applyRoundPlan", proposal: propose({ kind: "hurt", characterId: "c-nobody", count: 1, sides: 6, damageType: "fire" }) })).toThrow(/invalidPlan/);
    expect(() => run(round, system, { kind: "applyRoundPlan", proposal: propose({ kind: "hurt", characterId: "c-mira", count: 40, sides: 6, damageType: "fire" }) })).toThrow(/invalidPlan/);
  });
});

describe("a fight that opens in ambush", () => {
  const ambushed = (dc: number): EncounterSpec => ({ ...skirmish, partyZoneId: "gate", ambush: { dc } });
  const surprisedHeroes = (fight: Fight): string[] =>
    fight.events.flatMap((event) => (event.kind === "effectApplied" && event.effect.definition === "condition:surprised" ? [event.combatantId] : []));

  it("takes the party by surprise when no hero's passive Perception reaches the foes' stealth", () => {
    const state = partyOfThree();
    const best = Math.max(...Object.values(state.characters).map(passivePerception));
    const fight = new Fight(state).run(organizer, { kind: "startEncounter", spec: ambushed(best + 1) });
    expect(surprisedHeroes(fight).sort()).toEqual(Object.keys(state.characters).sort());
  });

  it("spares the party when even one hero notices", () => {
    const state = partyOfThree();
    const best = Math.max(...Object.values(state.characters).map(passivePerception));
    const fight = new Fight(state).run(organizer, { kind: "startEncounter", spec: ambushed(best) });
    expect(surprisedHeroes(fight)).toEqual([]);
  });

  it("leaves a fight the story says outright alone", () => {
    const fight = new Fight(partyOfThree()).run(organizer, { kind: "startEncounter", spec: { ...ambushed(30), surprised: "foes" } });
    expect(surprisedHeroes(fight)).toEqual(["goblin-a", "goblin-b"]);
  });
});

describe("a fight that opens in dread", () => {
  const dreadful = (dc: number): EncounterSpec => ({ ...skirmish, dread: { ability: "wis", dc } });
  const frightened = (fight: Fight): string[] =>
    fight.events.flatMap((event) => (event.kind === "effectApplied" && event.effect.definition === "condition:frightened" ? [event.combatantId] : []));

  it("frightens every hero who fails the save, and starts the turns only after the saves land", () => {
    const state = partyOfThree();
    const fight = new Fight(state).run(organizer, { kind: "startEncounter", spec: dreadful(30) });
    expect(frightened(fight).sort()).toEqual(Object.keys(state.characters).sort());
    expect(fight.kinds().filter((kind) => kind === "dreadRolled")).toHaveLength(Object.keys(state.characters).length);
    expect(fight.kinds().indexOf("turnOrderSet")).toBeGreaterThan(fight.kinds().lastIndexOf("dreadRolled"));
    expect(fight.encounter.dreadFailed).toHaveLength(Object.keys(state.characters).length);
  });

  it("leaves heroes who pass the save unafraid", () => {
    const fight = new Fight(partyOfThree()).run(organizer, { kind: "startEncounter", spec: dreadful(1) });
    expect(frightened(fight)).toEqual([]);
    expect(fight.encounter.dreadFailed ?? []).toEqual([]);
    expect(fight.encounter.status).toBe("active");
  });
});

describe("a borrowed monster made tougher", () => {
  const withStats = (stats: EncounterSpec["monsters"][number]["stats"]): EncounterSpec => ({ ...skirmish, monsters: skirmish.monsters.map((monster, index) => (index === 0 ? { ...monster, ...(stats === undefined ? {} : { stats }) } : monster)) });

  it("uses the adventure's hit points, armor class and attack bonuses for that monster only", () => {
    const plain = new Fight(partyOfThree()).run(organizer, { kind: "startEncounter", spec: skirmish });
    const tough = new Fight(partyOfThree()).run(organizer, { kind: "startEncounter", spec: withStats({ hp: 40, armorClass: 19, toHit: 3, damage: 2 }) });
    const first = skirmish.monsters[0]?.monsterId.slice("monster:".length) ?? "";
    const id = `${first}-a`;
    const before = plain.combatant(id);
    const after = tough.combatant(id);
    expect(after).toMatchObject({ maxHp: 40, hp: 40, armorClass: 19 });
    expect(after.attacks[0]?.toHit).toBe((before.attacks[0]?.toHit ?? 0) + 3);
    expect(after.attacks[0]?.damage.modifier).toBe((before.attacks[0]?.damage.modifier ?? 0) + 2);
    // The other monster is as it was.
    const other = skirmish.monsters[1] === undefined ? "" : `${first}-b`;
    expect(tough.combatant(other).maxHp).toBe(plain.combatant(other).maxHp);
  });
});

describe("what a scene brings with a long rest", () => {
  const story: PartyEffect[] = [
    { kind: "notice", noticeId: "rest:n", text: "The fire crackles low." },
    { kind: "grantKeepsake", keepsake: { id: "dream-charm", name: "Dream charm", description: "Woven in your sleep." } },
  ];
  const rest = (kind: "short" | "long", effects: PartyEffect[]): ReturnType<typeof run> => run(partyOfThree(), organizer, { kind: "takeRest", rest: kind, story: effects });

  it("plays the scene's lines and gifts once the rest is taken", () => {
    const step = rest("long", story);
    expect(step.events.some((event) => event.kind === "restTaken")).toBe(true);
    expect(step.state.keepsakes).toMatchObject({ "dream-charm": { name: "Dream charm" } });
    expect(deliveries(step)).toContainEqual({ kind: "storyNotice", text: "The fire crackles low." });
    // A second long rest brings them nowhere again.
    const again = run(step.state, organizer, { kind: "takeRest", rest: "long", story });
    expect(deliveries(again)).not.toContainEqual({ kind: "storyNotice", text: "The fire crackles low." });
  });

  it("refuses anything but lines, clues, flags, rewards and keepsakes, and gives a short rest nothing", () => {
    expect(() => rest("long", [{ kind: "transitionScene", sceneId: "scene:elsewhere" }])).toThrow(/invalidPlan/);
    expect(() => rest("short", story)).toThrow(/invalidPlan/);
  });
});
