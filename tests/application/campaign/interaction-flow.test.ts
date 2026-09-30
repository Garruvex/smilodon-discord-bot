import { describe, expect, it } from "vitest";

import { CampaignCommandBus } from "../../../src/application/campaign/campaign-command-bus.js";
import { assembleContext } from "../../../src/application/campaign/dm/context-assembler.js";
import { ScriptedNarrator, ScriptedPlanner } from "../../../src/application/campaign/dm/scripted-dm.js";
import type { CampaignKey } from "../../../src/application/campaign/ports/campaign-store.js";
import { RulesetCatalog } from "../../../src/application/campaign/rules/ruleset-catalog.js";
import { ManualClock } from "../../../src/application/campaign/time/manual-clock.js";
import { DmJobWorker } from "../../../src/application/campaign/workers/dm-job-worker.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import type { AdventureBible } from "../../../src/domain/campaign/adventure/adventure-bible.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { InMemoryCampaignStore } from "../../../src/infrastructure/persistence/campaign/in-memory-campaign-store.js";
import { alex, d20Roll, jamie, newCampaign, ruleset, system } from "../../domain/campaign/campaign-fixtures.js";
import { testBible } from "./dm-fixtures.js";

// The whole path of an authored interaction: the Planner names it, the DM job swaps in its check, the engine rolls it and applies
// the results, and the Narrator never sees the notes.

const key: CampaignKey = { guildId: "g-1", campaignId: "camp-1" };
const interactionSecret = "SECRET-INTERACTION-the-board-hides-a-purse";
const bible: AdventureBible = {
  ...testBible,
  interactions: [
    {
      id: "interaction:pry-board",
      sceneId: "scene:tavern",
      label: "Pry up the loose floorboard",
      dmNotes: interactionSecret,
      check: { ability: "dex", dc: 10 },
      requires: {},
      pay: 0,
      attempts: 1,
      onSuccess: [
        { kind: "reveal", clue: "clue:cellar-key" },
        { kind: "reward", gold: 30 },
        { kind: "set", flag: "board-open" },
      ],
      onFailure: [{ kind: "set", flag: "board-stuck" }],
      tiers: [{ dc: 20, effects: [{ kind: "reward", gold: 70 }] }],
    },
  ],
};

async function playRound(d20: number): Promise<{ state: CampaignState; planner: ScriptedPlanner; narrator: ScriptedNarrator }> {
  const planner = new ScriptedPlanner([
    {
      roundNumber: 1,
      actions: [{ characterId: "c-mira", resolution: { kind: "check", test: { kind: "skill", skill: "perception" }, dcTier: "medium", rollModeReasons: [] }, interactionId: "interaction:pry-board" }],
    },
  ]);
  const narrator = new ScriptedNarrator([{ text: "The board comes up." }]);
  const store = new InMemoryCampaignStore();
  const content = ruleset().content;
  const bus = new CampaignCommandBus({ unitOfWork: store, rulesets: new RulesetCatalog([content]), clock: new ManualClock(0) });
  await store.transaction((tx) =>
    tx.createCampaign(key, {
      state: { ...newCampaign(), sceneId: "scene:tavern" },
      revision: 0,
      ruleset: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} },
      adventure: { adventureId: bible.id, version: bible.version },
    }),
  );
  const worker = new DmJobWorker({ unitOfWork: store, bus, planner, narrator, adventures: { find: (): AdventureBible => bible }, glossaries: { en: enSrd51Glossary }, maxAttempts: 2 });
  await bus.execute(key, { kind: "openRound" }, { commandId: "1", actor: system });
  await bus.execute(key, { kind: "submitAction", characterId: "c-mira", text: "I pry up the loose board by the hearth." }, { commandId: "2", actor: alex });
  await bus.execute(key, { kind: "pass", characterId: "c-borin" }, { commandId: "3", actor: jamie });
  await worker.runOnce(); // plan
  const planned = (await store.transaction((tx) => tx.loadCampaign(key)))?.state;
  const check = Object.values(planned?.checks ?? {})[0];
  if (check === undefined) throw new Error("no check was planned");
  expect(check).toMatchObject({ dc: 10, test: { kind: "ability", ability: "dex" } });
  await bus.execute(key, { kind: "requestRoll", checkId: check.id }, { commandId: "4", actor: alex });
  await bus.execute(key, { kind: "recordRoll", rollId: check.rollId, result: { kind: "d20Test", roll: d20Roll("normal", [d20], check.spec.modifier) } }, { commandId: "5", actor: system });
  await worker.runOnce(); // narrate
  const state = (await store.transaction((tx) => tx.loadCampaign(key)))?.state;
  if (state === undefined) throw new Error("missing campaign");
  return { state, planner, narrator };
}

describe("an authored interaction, start to finish", () => {
  it("rolls the authored check, and a success reveals the clue, pays the reward and sets the flag", async () => {
    const { state } = await playRound(12);
    expect(state.clues.map((clue) => clue.id)).toEqual(["clue:cellar-key"]);
    expect(state.gold).toBe(30);
    expect(state.flags).toMatchObject({ "board-open": 1, "done:interaction:pry-board": 1, "tried:interaction:pry-board": 1 });
    expect(state.flags?.["board-stuck"]).toBeUndefined();
  });

  it("adds the higher tier's reward for a high total, and runs the failure branch only on a miss", async () => {
    expect((await playRound(19)).state.gold).toBe(100);
    const miss = await playRound(1);
    expect(miss.state.gold).toBe(0);
    expect(miss.state.flags).toMatchObject({ "board-stuck": 1, "tried:interaction:pry-board": 1 });
    expect(miss.state.flags?.["done:interaction:pry-board"]).toBeUndefined();
  });

  it("tells the Planner the notes and what the interaction does, and never the Narrator", async () => {
    const { planner, narrator } = await playRound(12);
    const plannerText = JSON.stringify(planner.requests[0]?.context);
    expect(plannerText).toContain(interactionSecret);
    expect(plannerText).toContain("interaction:pry-board");
    expect(planner.requests[0]?.story.interactions).toEqual([{ id: "interaction:pry-board", sceneId: "scene:tavern", label: "Pry up the loose floorboard" }]);
    expect(JSON.stringify(narrator.requests)).not.toContain(interactionSecret);
    expect(JSON.stringify(narrator.requests)).not.toContain("Pry up the loose floorboard");
  });

  it("puts the interaction in the Planner's context and keeps it out of the Narrator's", () => {
    const base = { bible, state: { ...newCampaign(), sceneId: "scene:tavern" as const }, events: [], glossary: enSrd51Glossary, content: ruleset().content, language: "en" as const };
    const planner = assembleContext({ ...base, audience: "planner" } as never);
    const narrator = assembleContext({ ...base, audience: "narrator" } as never);
    expect(JSON.stringify(planner)).toContain("interaction:pry-board");
    expect(JSON.stringify(narrator)).not.toContain("interaction:pry-board");
  });
});
