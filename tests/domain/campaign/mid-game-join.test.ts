import { describe, expect, it } from "vitest";

import type { CharacterSheet } from "../../../src/domain/campaign/character/character-sheet.js";
import { alex, jamie, mira, newCampaign, organizer, reject, run, system } from "./campaign-fixtures.js";

// A player who joins while a round is open takes part from the next round, however quickly the table gets through this one.

describe("joining while a round is open", () => {
  const pip: CharacterSheet = { ...mira, id: "c-pip", ownerUserId: "u-sam", name: "Pip" };

  it("is not part of the open round, but is in the next one even when everyone passes", () => {
    let state = run(newCampaign(), system, { kind: "openRound" }).state;
    state = run(state, organizer, { kind: "joinHero", sheet: pip }).state;
    expect(state.round?.participants).not.toContain("c-pip");
    expect(reject(state, { kind: "user", userId: "u-sam" }, { kind: "submitAction", characterId: "c-pip", text: "Hello." })).toEqual({ code: "notParticipant" });

    state = run(state, alex, { kind: "pass", characterId: "c-mira" }).state;
    state = run(state, jamie, { kind: "pass", characterId: "c-borin" }).state;
    expect(state.round?.number).toBe(2);
    expect(state.round?.participants).toContain("c-pip");
  });
});
