import { describe, expect, it } from "vitest";

import { assembleContext } from "../../../src/application/campaign/dm/context-assembler.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { rig, startedCampaign, starter } from "./campaign-rig.js";

// The DM is told the story's own clock, and told it is a fact.

describe("the story's clock in what the DM reads", () => {
  async function context(world: { day: number; time: "dusk"; weather?: "rain" } | undefined, audience: "planner" | "narrator"): Promise<string> {
    const r = rig();
    const key = await startedCampaign(r);
    const stored = await r.store.transaction((tx) => tx.loadCampaign(key));
    if (stored === undefined) throw new Error("state");
    const state = world === undefined ? stored.state : { ...stored.state, world };
    const built = assembleContext({ audience, state, events: [], bible: starter.en.bible, glossary: enSrd51Glossary, budgetTokens: 30_000 });
    return built.sections.map((section) => section.text).join("\n");
  }

  it("gives both the Planner and the Narrator the day, time and weather", async () => {
    for (const audience of ["planner", "narrator"] as const) {
      expect(await context({ day: 2, time: "dusk", weather: "rain" }, audience)).toContain("Story time: day 2, dusk, rain.");
    }
  });

  it("says nothing of time for an adventure that keeps no clock", async () => {
    expect(await context(undefined, "narrator")).not.toContain("Story time");
  });

  it("tells the Narrator the clock is a fact it may not change", async () => {
    expect(await context({ day: 1, time: "dusk" }, "narrator")).toContain("the engine moves the clock, not you");
  });
});

describe("a scene change the table has not agreed to, in what the DM reads", () => {
  it("says the party is still where it was and has not arrived", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    const stored = await r.store.transaction((tx) => tx.loadCampaign(key));
    if (stored === undefined) throw new Error("state");
    const [, there] = starter.en.bible.scenes;
    if (there === undefined) throw new Error("scene");
    const state = { ...stored.state, pendingMove: { sceneId: there.id, proposedRound: 1, effects: [], objectors: [] } };
    const built = assembleContext({ audience: "narrator", state, events: [], bible: starter.en.bible, glossary: enSrd51Glossary, budgetTokens: 30_000 });
    const text = built.sections.map((section) => section.text).join("\n");
    expect(text).toContain(`The party is heading to ${there.title} but has not arrived`);
    const quiet = assembleContext({ audience: "narrator", state: stored.state, events: [], bible: starter.en.bible, glossary: enSrd51Glossary, budgetTokens: 30_000 });
    expect(quiet.sections.map((section) => section.text).join("\n")).not.toContain("is heading to");
  });
});

describe("rounds played in a place the party has left, in what the DM reads", () => {
  it("keeps only their narration, so their doors and creatures are not taken for this room's", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    const stored = await r.store.transaction((tx) => tx.loadCampaign(key));
    if (stored === undefined) throw new Error("state");
    const [, there] = starter.en.bible.scenes;
    if (there === undefined) throw new Error("scene");
    const hero = Object.keys(stored.state.characters)[0];
    if (hero === undefined) throw new Error("hero");
    const events = [
      { kind: "roundOpened", roundNumber: 1, participants: [hero], closesAt: null },
      { kind: "actionSubmitted", roundNumber: 1, characterId: hero, text: "talk to the snake" },
      { kind: "narrationRecorded", roundNumber: 1, text: "The snake hisses." },
      { kind: "sceneTransitioned", roundNumber: 1, sceneId: there.id },
      { kind: "roundOpened", roundNumber: 2, participants: [hero], closesAt: null },
      { kind: "actionSubmitted", roundNumber: 2, characterId: hero, text: "look around" },
    ] as unknown as Parameters<typeof assembleContext>[0]["events"];
    const built = assembleContext({ audience: "narrator", state: stored.state, events, bible: starter.en.bible, glossary: enSrd51Glossary, budgetTokens: 30_000 });
    const text = built.sections.map((section) => section.text).join("\n");
    expect(text).toContain("The snake hisses.");
    expect(text).not.toContain("talk to the snake");
    expect(text).toContain("look around");
  });
});

describe("a defeated NPC, in what the DM reads", () => {
  it("is named as unable to speak or react", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    const stored = await r.store.transaction((tx) => tx.loadCampaign(key));
    if (stored === undefined) throw new Error("state");
    const npc = starter.en.bible.npcs[0];
    if (npc === undefined) throw new Error("npc");
    const state = { ...stored.state, npcsDown: [npc.id] };
    for (const audience of ["planner", "narrator"] as const) {
      const built = assembleContext({ audience, state, events: [], bible: starter.en.bible, glossary: enSrd51Glossary, budgetTokens: 30_000 });
      expect(built.sections.map((section) => section.text).join("\n")).toContain(`Defeated and dead or unconscious: ${npc.name}`);
    }
  });
});
