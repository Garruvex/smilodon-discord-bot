import { describe, expect, it } from "vitest";

import { alex, jamie, kinds, newCampaign, organizer, reject, run } from "./campaign-fixtures.js";

// The organizer frees the seat of a player who is away, so the table is never stuck full with someone who is not there.

describe("freeing an away player's seat", () => {
  const awayJamie = () => run(newCampaign(), jamie, { kind: "markAway", userId: "u-jamie" }).state;

  it("takes the player and their hero off the table and keeps the hero's name for the story told so far", () => {
    const step = run(awayJamie(), organizer, { kind: "retireMember", userId: "u-jamie" });
    expect(kinds(step.events)).toContain("memberRetired");
    expect(step.state.members["u-jamie"]).toBeUndefined();
    const heroId = Object.keys(newCampaign().characters).find((id) => newCampaign().characters[id]?.ownerUserId === "u-jamie")!;
    expect(step.state.characters[heroId]).toBeUndefined();
    expect(step.state.retiredHeroes?.[heroId]).toBe(newCampaign().characters[heroId]?.name);
    expect(step.state.members["u-alex"]).toBeDefined();
  });

  it("tells the table the seat is open", () => {
    const step = run(awayJamie(), organizer, { kind: "retireMember", userId: "u-jamie" });
    expect(step.requests).toContainEqual({ kind: "deliver", delivery: { kind: "seatFreed", name: expect.any(String) } });
  });

  it("is the organizer's to do, for a player who is present or away", () => {
    expect(reject(awayJamie(), alex, { kind: "retireMember", userId: "u-jamie" })).toEqual({ code: "notOrganizer" });
    expect(kinds(run(newCampaign(), organizer, { kind: "retireMember", userId: "u-jamie" }).events)).toContain("memberRetired");
    expect(reject(awayJamie(), organizer, { kind: "retireMember", userId: "u-nobody" })).toEqual({ code: "notMember" });
  });
});
