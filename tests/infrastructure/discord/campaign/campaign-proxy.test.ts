import { describe, expect, it } from "vitest";

import { encounterSpec, findEncounter } from "../../../../src/domain/campaign/adventure/adventure-bible.js";
import { enSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { DiscordCampaignPresenter } from "../../../../src/infrastructure/discord/campaign/campaign-presenter.js";
import { quiet, starter, tellOpening } from "../../../application/campaign/campaign-rig.js";
import { contentOf, fakeInteraction, harness, heroes, type Harness, type Sent } from "./handler-harness.js";

async function twoPlayers(): Promise<Harness> {
  const t = await harness();
  for (const [index, userId] of ["u-org", "u-two"].entries()) {
    await t.press("join", userId);
    await t.select(userId, heroes[index]?.id ?? "");
  }
  await t.press("start", "u-org");
  await tellOpening(t.r, t.key);
  await t.cards.sync(t.key);
  return t;
}

async function pickProxy(t: Harness, userId: string, value: string): Promise<Sent[]> {
  const { interaction, sent } = fakeInteraction({ customId: `dnd:proxy:${t.key.campaignId}`, userId, values: [value], kind: "select" });
  await t.handler.execute({ interaction, logger: quiet as never });
  return sent;
}

const menus = (sent: readonly Sent[]): { id: string; options: { value: string; label: string; default?: boolean }[] }[] => {
  const last = [...sent].reverse().find((entry) => entry.kind === "edit");
  const rows = (last?.payload as { components?: { toJSON(): { components: Record<string, unknown>[] } }[] } | undefined)?.components ?? [];
  return rows.flatMap((row) => row.toJSON().components.flatMap((component) => (Array.isArray(component.options) ? [{ id: String(component.custom_id), options: component.options as never }] : [])));
};

describe("naming a proxy", () => {
  it("offers the other players on My Hero, and saves the choice for fights", async () => {
    const t = await twoPlayers();
    const menu = menus(await t.press("myHero", "u-org")).find((entry) => entry.id.startsWith("dnd:proxy:"));
    expect(menu?.options.map((option) => option.value)).toEqual(["none", "u-two"]);
    expect(menu?.options[1]?.label).toBe(`${heroes[1]?.name}'s player`);
    expect(contentOf(await pickProxy(t, "u-org", "u-two"))).toBe("Done. While you are away, that player takes your hero's turns in fights. Nothing else of yours is theirs.");
    const state = (await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state;
    expect(state?.proxies).toEqual({ "u-org": "u-two" });
    // The menu remembers it, and Nobody takes it back.
    expect(menus(await t.press("myHero", "u-org")).find((entry) => entry.id.startsWith("dnd:proxy:"))?.options.find((option) => option.default)?.value).toBe("u-two");
    expect(contentOf(await pickProxy(t, "u-org", "none"))).toBe("Done. While you are away your hero plays it safe on its own.");
    expect((await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state.proxies).toEqual({});
  });

  it("lets the proxy take the away player's turn from the turn menu, and pings them for it", async () => {
    const t = await twoPlayers();
    await pickProxy(t, "u-org", "u-two");
    // u-org steps away before the fight, so their hero is driven by the proxy from its first turn.
    await t.r.bus.execute(t.key, { kind: "markAway", userId: "u-org" }, { commandId: "org-away", actor: { kind: "user", userId: "u-org" } });
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(t.key);
      if (stored === undefined) throw new Error("state");
      await tx.saveCampaign(t.key, { ...stored.state, round: null }, stored.revision);
    });
    const chapel = findEncounter(starter.en.bible, "encounter:chapel-fight");
    if (chapel === undefined) throw new Error("encounter");
    await t.r.bus.execute(t.key, { kind: "startEncounter", spec: encounterSpec(chapel) }, { commandId: "fight", actor: { kind: "user", userId: "u-org" } });
    // Play on until it is the away hero's turn; the engine waits for the proxy, and u-two ends their own turns.
    for (let step = 0; step < 30; step += 1) {
      await t.r.runtime().runOnce();
      const state = (await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state;
      const fight = state?.encounter;
      if (fight === null || fight === undefined || fight.status === "ended") throw new Error(`the fight ended first at step ${step}: ${JSON.stringify({ status: fight?.status, outcome: fight?.outcome, round: fight?.round, current: fight === undefined || fight === null ? null : fight.order[fight.turnIndex] })}`);
      const current = fight.combatants[fight.order[fight.turnIndex] ?? ""];
      if (current?.id === heroes[0]?.id) break;
      if (current?.id === heroes[1]?.id) await t.r.bus.execute(t.key, { kind: "endTurn", combatantId: current?.id ?? "" }, { commandId: `two-${step}`, actor: { kind: "user", userId: "u-two" } });
    }
    await t.cards.sync(t.key);
    // The ping goes to the proxy, naming who they play for.
    const fight = (await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state.encounter;
    const presenter = new DiscordCampaignPresenter({ unitOfWork: t.r.store, messages: t.messages, cards: t.cards, adventures: t.r.adventures, glossaries: { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary } });
    await presenter.present(t.key, { kind: "combatTurn", encounterId: fight?.id ?? "", combatantId: heroes[0]?.id ?? "" });
    const ping = t.messages.posts.filter((post) => post.content.includes("you are playing for")).at(-1);
    expect(ping?.mentions).toEqual(["u-two"]);
    expect(ping?.content).toContain("<@u-org>");
    // The proxy opens the turn menu and is offered the away hero's actions; the owner is not (they are away).
    const menu = fakeInteraction({ customId: `dnd:turn:${t.key.campaignId}`, userId: "u-two", messageId: (await t.r.service.get(t.key))?.record.cards.adventure?.messageId ?? "", kind: "button" });
    await t.handler.execute({ interaction: menu.interaction, logger: quiet as never });
    expect(menus(menu.sent).some((entry) => entry.id.startsWith("dnd:pick:"))).toBe(true);
    expect(contentOf(menu.sent)).toContain(heroes[0]?.name ?? "");

    // What the menu shows is what its controls act on: the proxy ends the away hero's turn.
    const end = fakeInteraction({ customId: `dnd:endTurn:${t.key.campaignId}:yes`, userId: "u-two", kind: "button" });
    await t.handler.execute({ interaction: end.interaction, logger: quiet as never });
    expect(contentOf(end.sent)).toBe("You ended your turn.");
    const after = (await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state.encounter;
    expect(after?.combatants[after.order[after.turnIndex] ?? ""]?.id).not.toBe(heroes[0]?.id);
  });
});
