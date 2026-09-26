import { describe, expect, it } from "vitest";

import { CampaignPlayController, type PlayResult } from "../../../src/application/campaign/campaign-play-controller.js";
import type { CardRefresher } from "../../../src/application/campaign/ports/card-refresher.js";
import type { CampaignKey } from "../../../src/application/campaign/ports/campaign-store.js";
import { starterAdventureId } from "../../../src/infrastructure/campaign/starter-adventures.js";
import { guildId, rig, starter, startedCampaign, type Rig } from "./campaign-rig.js";

const heroes = starter.en.heroes.map((hero) => hero.id);

class Refreshes implements CardRefresher {
  public readonly keys: CampaignKey[] = [];
  public refresh(key: CampaignKey): void {
    this.keys.push(key);
  }
}

async function twoPlayerCampaign(r: Rig): Promise<CampaignKey> {
  const created = await r.service.create({ guildId, organizerId: "u-org", name: "Moonlit Ruins", language: "en", adventureId: starterAdventureId, pacing: { preset: "live" }, minPlayers: 2 });
  if (created.kind !== "ok") throw new Error("create");
  const { key } = created.value;
  for (const [index, userId] of ["u-org", "u-b"].entries()) {
    await r.service.join(key, userId);
    await r.service.chooseHero(key, userId, heroes[index] ?? "");
  }
  await r.service.start(key, "u-org");
  return key;
}

function controllerFor(r: Rig): { controller: CampaignPlayController; refreshes: Refreshes } {
  const refreshes = new Refreshes();
  return { controller: new CampaignPlayController({ unitOfWork: r.store, bus: r.bus, refresher: refreshes }), refreshes };
}

const refusal = (result: PlayResult): string => (result.kind === "refused" ? result.reason : "ok");

describe("the play controller", () => {
  it("submits and passes for the clicker's own hero, and asks for the cards to be redrawn", async () => {
    const r = rig();
    const key = await twoPlayerCampaign(r);
    const { controller, refreshes } = controllerFor(r);
    expect(await controller.submitAction(key, "u-org", "I greet the innkeeper.", "i-1")).toEqual({ kind: "ok" });
    expect(await controller.pass(key, "u-b", "i-2")).toEqual({ kind: "ok" });
    expect(refreshes.keys).toHaveLength(2);
    const round = (await r.store.transaction((tx) => tx.loadCampaign(key)))?.state.round;
    expect(round?.submissions[heroes[0] ?? ""]).toMatchObject({ kind: "action", text: "I greet the innkeeper." });
    expect(round?.status).toBe("planning");
  });

  it("does nothing twice for a repeated interaction", async () => {
    const r = rig();
    const key = await twoPlayerCampaign(r);
    const { controller } = controllerFor(r);
    await controller.submitAction(key, "u-org", "First.", "i-1");
    await controller.submitAction(key, "u-org", "Second.", "i-1");
    const round = (await r.store.transaction((tx) => tx.loadCampaign(key)))?.state.round;
    expect(round?.submissions[heroes[0] ?? ""]).toMatchObject({ text: "First." });
  });

  it("refuses people who are not in the campaign, and things the engine refuses", async () => {
    const r = rig();
    const key = await twoPlayerCampaign(r);
    const { controller, refreshes } = controllerFor(r);
    expect(refusal(await controller.submitAction(key, "u-stranger", "Hi.", "i-1"))).toBe("noHero");
    expect(refusal(await controller.submitAction(key, "u-org", "   ", "i-2"))).toBe("emptyAction");
    expect(refusal(await controller.pause(key, "u-b", "i-3"))).toBe("notOrganizer");
    expect(refusal(await controller.closeRound(key, "u-b", "i-4"))).toBe("notOrganizer");
    expect(refreshes.keys).toHaveLength(0);
  });

  it("refuses lobbies, archived campaigns, and unknown ones", async () => {
    const r = rig();
    const created = await r.service.create({ guildId, organizerId: "u-org", name: "Lobby Only", language: "en", adventureId: starterAdventureId, pacing: { preset: "live" } });
    if (created.kind !== "ok") throw new Error("create");
    const { controller } = controllerFor(r);
    expect(refusal(await controller.pass(created.value.key, "u-org", "i-1"))).toBe("notActive");
    expect(refusal(await controller.pass({ guildId, campaignId: "missing" }, "u-org", "i-2"))).toBe("notFound");
  });

  it("rolls for the clicker's own pending check, and says when there is none", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    const { controller } = controllerFor(r);
    expect(refusal(await controller.roll(key, "u-org", "i-1"))).toBe("noPendingRoll");
    const hero = heroes[0] ?? "";
    r.plannerScript.push({ roundNumber: 1, actions: [{ characterId: hero, resolution: { kind: "check", test: { kind: "skill", skill: "stealth" }, dcTier: "medium", rollModeReasons: [] } }] });
    await controller.submitAction(key, "u-org", "I sneak.", "i-2");
    await r.runtime().runOnce();
    expect(await controller.roll(key, "u-org", "i-3")).toEqual({ kind: "ok" });
    await r.runtime().runOnce();
    const state = (await r.store.transaction((tx) => tx.loadCampaign(key)))?.state;
    expect(Object.values(state?.checks ?? {})[0]?.status ?? "resolved").toBe("resolved");
  });

  it("lets a player go away and come back, and the organizer pause and resume", async () => {
    const r = rig();
    const key = await twoPlayerCampaign(r);
    const { controller } = controllerFor(r);
    expect(await controller.away(key, "u-b", "i-1")).toEqual({ kind: "ok" });
    expect((await r.store.transaction((tx) => tx.loadCampaign(key)))?.state.members["u-b"]?.availability).toBe("away");
    expect(await controller.back(key, "u-b", "i-2")).toEqual({ kind: "ok" });
    expect(await controller.pause(key, "u-org", "i-3")).toEqual({ kind: "ok" });
    expect(refusal(await controller.submitAction(key, "u-org", "Hi.", "i-4"))).toBe("campaignWaiting");
    expect(refusal(await controller.continue(key, "u-b", "i-5"))).toBe("notOrganizer");
    expect(await controller.continue(key, "u-org", "i-6")).toEqual({ kind: "ok" });
  });
});
