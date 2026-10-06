import { describe, expect, it } from "vitest";

import { tellsFor } from "../../../src/application/campaign/dm/npc-tells.js";
import type { AdventureBible, BibleNpc } from "../../../src/domain/campaign/adventure/adventure-bible.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";

const bible = { clues: [{ id: "clue:curse", sceneId: "scene:a", publicText: "The scarecrow is cursed.", dmNotes: "" }, { id: "clue:deal", sceneId: "scene:a", publicText: "The old man cheated her.", dmNotes: "" }] } as unknown as AdventureBible;
const npc = (tells: BibleNpc["tells"]): BibleNpc => ({ id: "npc:hag", name: "Hag", voice: "", publicDescription: "", secret: "", ...(tells === undefined ? {} : { tells }) }) as BibleNpc;
const state = (known: readonly string[] = []): CampaignState => ({ clues: known.map((id) => ({ id, text: "" })) }) as unknown as CampaignState;

describe("what an NPC tells when asked", () => {
  it("gives a clue when the question names one of its topics, in either language", () => {
    const hag = npc([{ clue: "clue:curse" as never, topics: ["curse", "詛咒"] }, { clue: "clue:deal" as never, topics: ["contract", "契約"] }]);
    expect(tellsFor(hag, "Who laid the CURSE on it?", state(), bible).map((tell) => tell.clueId)).toEqual(["clue:curse"]);
    expect(tellsFor(hag, "詛咒怎麼消除 誰下的詛咒", state(), bible).map((tell) => tell.clueId)).toEqual(["clue:curse"]);
    expect(tellsFor(hag, "What did he sign? the contract?", state(), bible).map((tell) => tell.clueId)).toEqual(["clue:deal"]);
  });

  it("gives a tell without topics to any question, the free way to a clue", () => {
    expect(tellsFor(npc([{ clue: "clue:curse" as never }]), "Hello?", state(), bible)).toEqual([{ clueId: "clue:curse", text: "The scarecrow is cursed." }]);
  });

  it("does not repeat a clue the party already has, nor tell what was not asked about", () => {
    const hag = npc([{ clue: "clue:curse" as never, topics: ["curse"] }]);
    expect(tellsFor(hag, "Tell me about the curse", state(["clue:curse"]), bible)).toEqual([]);
    expect(tellsFor(hag, "What is your name?", state(), bible)).toEqual([]);
    expect(tellsFor(npc(undefined), "curse", state(), bible)).toEqual([]);
  });
});
