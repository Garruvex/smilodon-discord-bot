import { describe, expect, it } from "vitest";

import type { CampaignState } from "../../../../src/domain/campaign/state/campaign-state.js";
import { quiet, starter, tellOpening } from "../../../application/campaign/campaign-rig.js";
import { adventure, contentOf, fakeInteraction, harness, heroes, party, started, type Sent } from "./handler-harness.js";

describe("the lobby controls", () => {
  it("seats the player and offers the free heroes", async () => {
    const t = await harness();
    const sent = await t.press("join", "u-a");
    expect(sent[0]?.kind).toBe("defer");
    const reply = sent.at(-1)?.payload as { content: string; components: { toJSON(): { components: { options: { value: string }[] }[] } }[] };
    expect(reply.content).toContain("You joined **Moonlit Ruins**");
    expect(reply.components[0]?.toJSON().components[0]?.options.map((option) => option.value)).toEqual(heroes.map((hero) => hero.id));
    expect((await t.r.service.get(t.key))?.record.lobby.members.map((member) => member.userId)).toEqual(["u-a"]);
  });

  it("saves the chosen hero and refuses one somebody else holds", async () => {
    const t = await harness();
    await t.press("join", "u-a");
    await t.press("join", "u-b");
    expect(contentOf(await t.select("u-a", heroes[0]?.id ?? ""))).toContain(`You will play **${heroes[0]?.name}**`);
    expect(contentOf(await t.select("u-b", heroes[0]?.id ?? ""))).toBe("Someone else already chose that hero.");
    const members = (await t.r.service.get(t.key))?.record.lobby.members ?? [];
    expect(members.map((member) => [member.userId, member.heroId])).toEqual([["u-a", heroes[0]?.id], ["u-b", null]]);
  });

  it("frees the seat when a player leaves, and refuses strangers", async () => {
    const t = await harness();
    await t.press("join", "u-a");
    expect(contentOf(await t.press("leave", "u-a"))).toBe("You left the lobby.");
    expect(contentOf(await t.press("leave", "u-x"))).toBe("You are not in this lobby. Join first.");
  });

  it("ignores a control on an old message and points to the newest one", async () => {
    const t = await harness();
    const sent = await t.press("join", "u-a", { onCard: "adventure" });
    expect(contentOf(sent)).toBe("That control is out of date. Use the newest message.");
    expect((await t.r.service.get(t.key))?.record.lobby.members).toEqual([]);
  });

  it("starts only for the organizer, once, and answers in the campaign's language", async () => {
    const t = await harness("zh-TW");
    await t.press("join", "u-org");
    await t.select("u-org", starter["zh-TW"].heroes[0]?.id ?? "");
    await t.press("join", "u-b");
    expect(contentOf(await t.press("start", "u-b"))).toBe("只有主辦人可以這麼做");
    expect(contentOf(await t.press("start", "u-org"))).toBe("所有人都要先選好英雄才能開始");
    await t.press("leave", "u-b");
    expect(contentOf(await t.press("start", "u-org"))).toBe("冒險已經開始");
    expect(t.messages.live(adventure)).toHaveLength(1);
  });
});

describe("the play controls", () => {
  it("opens a form first, saves the submitted action, and refuses an empty one", async () => {
    const t = await harness();
    await started(t);
    const opened = await t.press("act", "u-org");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.kind).toBe("modal");
    expect(JSON.stringify(opened[0]?.payload)).toContain(`dnd:act:${t.key.campaignId}`);

    expect(contentOf(await t.submit("u-org", "I greet the innkeeper."))).toBe("Your action is saved. You can change it until the round closes.");
    const round = (await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state.round;
    expect(round?.submissions[heroes[0]?.id ?? ""]).toMatchObject({ kind: "action", text: "I greet the innkeeper." });
    expect(contentOf(await t.submit("u-org", "   "))).toBe("Write what your hero does first.");
  });

  it("explains refusals privately: strangers, waiting play, rolls that are not there", async () => {
    const t = await harness();
    await started(t);
    expect(contentOf(await t.press("pass", "u-stranger"))).toBe("You do not have a hero in this campaign.");
    expect(contentOf(await t.press("roll", "u-org"))).toBe("You have no roll waiting.");
    await t.r.bus.execute(t.key, { kind: "pauseCampaign", reason: "organizer" }, { commandId: "p", actor: { kind: "user", userId: "u-org" } });
    await t.cards.sync(t.key);
    expect(contentOf(await t.press("pass", "u-org"))).toBe("Play is on hold. The organizer or a returning player must continue it.");
  });

  it("passes, goes away, and returns", async () => {
    const t = await harness();
    await started(t);
    expect(contentOf(await t.press("away", "u-org"))).toBe("You are away. The party will carry on without you.");
    expect(contentOf(await t.press("back", "u-org"))).toBe("Welcome back. You rejoin at the next round.");
  });

  it("shows a hero's sheet privately, from My Hero or a hero card", async () => {
    const t = await harness();
    await started(t);
    expect(contentOf(await t.press("myHero", "u-org"))).toContain(heroes[0]?.name ?? "");
    expect(contentOf(await t.press("details", "u-org", { argument: heroes[0]?.id ?? "", onCard: `hero:${heroes[0]?.id}` }))).toContain("STR");
    expect(contentOf(await t.press("myHero", "u-stranger"))).toBe("You do not have a hero in this campaign.");
  });

  it("says a campaign no longer exists", async () => {
    const t = await harness();
    const { interaction, sent } = fakeInteraction({ customId: "dnd:pass:missing", userId: "u", kind: "button" });
    await t.handler.execute({ interaction, logger: quiet as never });
    expect(contentOf(sent)).toBe("That campaign no longer exists.");
  });
});

describe("a fallen hero", () => {
  it("is offered a new hero from My Hero, and joins the party by choosing one", async () => {
    const t = await harness();
    await t.press("join", "u-org");
    await t.select("u-org", heroes[0]?.id ?? "");
    await t.press("join", "u-b");
    await t.select("u-b", heroes[1]?.id ?? "");
    await t.press("start", "u-org");
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(t.key);
      if (stored === undefined) throw new Error("campaign");
      await tx.saveCampaign(t.key, { ...stored.state, heroStatus: { [heroes[1]?.id ?? ""]: { hp: 0, dead: true, resources: { spellSlots: {}, featureUses: {} } } } }, stored.revision);
    });
    const sent = await t.press("myHero", "u-b");
    const picker = sent.at(-1)?.payload as { content: string; components: { toJSON(): { components: { options: { value: string }[] }[] } }[] };
    expect(picker.content).toContain("Your hero has fallen for good");
    expect(picker.components[0]?.toJSON().components[0]?.options.map((option) => option.value)).toEqual([heroes[1]?.id, heroes[2]?.id]);

    const { interaction, sent: chosen } = fakeInteraction({ customId: `dnd:newHero:${t.key.campaignId}`, userId: "u-b", values: [heroes[2]?.id ?? ""], kind: "select" });
    await t.handler.execute({ interaction, logger: quiet as never });
    expect(contentOf(chosen)).toBe(`**${heroes[2]?.name}** joins the party.`);
    const state = (await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state;
    expect(state?.members["u-b"]?.characterId).toBe(`${heroes[2]?.id}-1`);
  });
});

describe("getting ready and gear", () => {
  const componentsOf = (sent: readonly Sent[]): unknown[] => {
    const last = [...sent].reverse().find((entry) => entry.kind === "edit");
    return ((last?.payload as { components?: unknown[] } | undefined)?.components ?? []);
  };
  const optionValues = (sent: readonly Sent[], menu = "gear"): string[] =>
    componentsOf(sent).flatMap((row) => {
      const json = (row as { toJSON(): { components: { custom_id?: string; options?: { value: string; label: string }[] }[] } }).toJSON();
      return json.components
        .filter((component) => component.custom_id?.startsWith(`dnd:${menu}:`) === true)
        .flatMap((component) => (component.options ?? []).map((option) => `${option.value}=${option.label}`));
    });

  it("waits for the Ready button after the opening, and opens round 1 when everyone has pressed it", async () => {
    const t = await harness();
    await t.press("join", "u-org");
    await t.select("u-org", heroes[0]?.id ?? "");
    await t.press("start", "u-org");
    await t.r.bus.execute(t.key, { kind: "recordOpening", text: "Welcome." }, { commandId: "op", actor: { kind: "system" } });
    await t.cards.sync(t.key);
    expect(flatText(t.messages.live(adventure))).toContain("Getting ready");

    expect(contentOf(await t.press("begin", "u-stranger"))).toBe("Only the organizer can do that.");
    expect(contentOf(await t.press("ready", "u-org"))).toBe("You are ready. The adventure begins when everyone is.");
    const state = (await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state;
    expect(state).toMatchObject({ opening: "done", round: { number: 1, status: "collecting" } });
    await t.cards.sync(t.key);
    expect(contentOf(await t.press("ready", "u-org"))).toBe("The table is not waiting for anyone to get ready.");
  });

  it("offers armor and shield controls on My Hero, and applies the choice", async () => {
    const t = await harness();
    await started(t);
    const sheet = await t.press("myHero", "u-org");
    expect(optionValues(sheet)).toEqual(["remove|item:chain-mail=Take off Chain Mail", "remove|item:shield=Take off Shield"]);

    const { interaction, sent } = fakeInteraction({ customId: `dnd:gear:${t.key.campaignId}`, userId: "u-org", values: ["remove|item:chain-mail"], kind: "select" });
    await t.handler.execute({ interaction, logger: quiet as never });
    expect(contentOf(sent)).toContain("Done. Your hero card shows what you wear.");
    expect(optionValues(sent)).toEqual(["wear|item:chain-mail=Put on Chain Mail", "remove|item:shield=Take off Shield"]);
    expect((await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state.characters[heroes[0]?.id ?? ""]?.worn).toEqual(["item:shield"]);
  });

  it("refuses a forged gear choice, or gear that is not there, privately", async () => {
    const t = await harness();
    await started(t);
    const forged = fakeInteraction({ customId: `dnd:gear:${t.key.campaignId}`, userId: "u-org", values: ["remove|not-an-item"], kind: "select" });
    await t.handler.execute({ interaction: forged.interaction, logger: quiet as never });
    expect(contentOf(forged.sent)).toBe("That is not possible right now.");
    const missing = fakeInteraction({ customId: `dnd:gear:${t.key.campaignId}`, userId: "u-org", values: ["wear|item:shortbow"], kind: "select" });
    await t.handler.execute({ interaction: missing.interaction, logger: quiet as never });
    expect(contentOf(missing.sent)).not.toContain("Done");
  });
});

describe("the pack, the stash, and gifts", () => {
  type MenuComponent = { custom_id?: string; options?: { value: string; label: string }[] };
  const menuValues = (sent: readonly Sent[], menu: string): string[] => {
    const last = [...sent].reverse().find((entry) => entry.kind === "edit");
    const rows = (last?.payload as { components?: { toJSON(): { components: MenuComponent[] } }[] } | undefined)?.components ?? [];
    return rows.flatMap((row) =>
      row
        .toJSON()
        .components.filter((component) => component.custom_id?.startsWith(`dnd:${menu}:`) === true)
        .flatMap((component) => (component.options ?? []).map((option) => `${option.value}=${option.label}`)),
    );
  };
  const pick = async (t: Awaited<ReturnType<typeof harness>>, menu: string, value: string, userId = "u-org"): Promise<Sent[]> => {
    const { interaction, sent } = fakeInteraction({ customId: `dnd:${menu}:${t.key.campaignId}`, userId, values: [value], kind: "select" });
    await t.handler.execute({ interaction, logger: quiet as never });
    return sent;
  };
  const stateOf = async (t: Awaited<ReturnType<typeof harness>>): Promise<CampaignState> => {
    const stored = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    if (stored === undefined) throw new Error("state");
    return stored.state;
  };
  const twoPlayers = async (): Promise<Awaited<ReturnType<typeof harness>>> => {
    const t = await harness();
    await t.press("join", "u-org");
    await t.select("u-org", heroes[0]?.id ?? "");
    await t.press("join", "u-two");
    await t.select("u-two", heroes[1]?.id ?? "");
    await t.press("start", "u-org");
    await tellOpening(t.r, t.key);
    await t.cards.sync(t.key);
    return t;
  };

  it("lists what the hero can stash or take, and moves items to and from the stash", async () => {
    const t = await harness();
    await started(t);
    const hero = heroes[0]?.id ?? "";
    const sheet = await t.press("myHero", "u-org");
    // Worn armor and the shield stay off the list until they are taken off; there is nobody to give to.
    expect(menuValues(sheet, "pack")).toEqual(["stash|item:longsword=Put Longsword in the stash"]);

    const stashed = await pick(t, "pack", "stash|item:longsword");
    expect(contentOf(stashed)).toContain("Done.");
    expect((await stateOf(t)).stash).toContain("item:longsword");
    expect(menuValues(stashed, "pack")).toEqual(["take|item:longsword=Take Longsword from the stash"]);

    await pick(t, "pack", "take|item:longsword");
    expect((await stateOf(t)).characters[hero]?.equipment).toContain("item:longsword");
    expect((await stateOf(t)).stash).not.toContain("item:longsword");
  });

  it("drinks a healing potion outside a fight", async () => {
    const t = await harness();
    await started(t);
    const hero = heroes[0]?.id ?? "";
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(t.key);
      const sheet = stored?.state.characters[hero];
      if (stored === undefined || sheet === undefined) throw new Error("state");
      const state: CampaignState = {
        ...stored.state,
        characters: { ...stored.state.characters, [hero]: { ...sheet, equipment: [...sheet.equipment, "item:potion-of-healing"] } },
        heroStatus: { ...stored.state.heroStatus, [hero]: { hp: 3, resources: { spellSlots: {}, featureUses: {} } } },
      };
      await tx.saveCampaign(t.key, state, stored.revision);
    });
    const sheet = await t.press("myHero", "u-org");
    expect(menuValues(sheet, "pack")).toContain("use|item:potion-of-healing=Drink Potion of Healing");

    expect(contentOf(await pick(t, "pack", "use|item:potion-of-healing"))).toContain("Done.");
    const after = await stateOf(t);
    expect(after.heroStatus[hero]?.hp).toBe(10);
    expect(after.characters[hero]?.equipment).not.toContain("item:potion-of-healing");
  });

  it("refuses a forged or stale pack choice privately", async () => {
    const t = await harness();
    await started(t);
    expect(contentOf(await pick(t, "pack", "stash|not-an-item"))).toBe("That is not possible right now.");
    expect(contentOf(await pick(t, "pack", "take|item:shortbow"))).toContain("You are not carrying that.");
    expect(contentOf(await pick(t, "pack", "use|item:longsword"))).toContain("That cannot be used like that.");
    expect(contentOf(await pick(t, "giveTo", "item:longsword>nobody"))).not.toContain("Offer sent");
  });

  it("offers an item to another hero, whose owner answers on the offer card", async () => {
    const t = await twoPlayers();
    const menu = menuValues(await t.press("myHero", "u-org"), "pack");
    expect(menu).toContain("give|item:longsword=Give Longsword…");
    const who = await pick(t, "pack", "give|item:longsword");
    expect(menuValues(who, "giveTo")).toEqual([`item:longsword>${heroes[1]?.id}=${heroes[1]?.name}`]);

    const sent = await pick(t, "giveTo", `item:longsword>${heroes[1]?.id}`);
    expect(contentOf(sent)).toContain("Offer sent.");
    await t.cards.sync(t.key);
    const offerId = Object.keys((await stateOf(t)).offers)[0] ?? "";
    expect(offerId).toBe("offer:1");
    const card = t.messages.live(party).find((message) => flatText([message]).includes("offers"));
    expect(flatText(card === undefined ? [] : [card])).toContain(`dnd:offerYes:${t.key.campaignId}:offer:1`);

    // Only the receiving hero's owner can accept it.
    expect(contentOf(await t.press("offerYes", "u-org", { argument: offerId, onCard: offerId }))).toBe("That is not your hero.");
    expect(contentOf(await t.press("offerYes", "u-two", { argument: offerId, onCard: offerId }))).toBe("You answered the offer.");
    const after = await stateOf(t);
    expect(after.offers).toEqual({});
    expect(after.characters[heroes[1]?.id ?? ""]?.equipment).toContain("item:longsword");
    await t.cards.sync(t.key);
    // The answered offer leaves the Party channel.
    expect(t.messages.live(party).some((message) => flatText([message]).includes("offers"))).toBe(false);
  });

  it("lets the giver take an offer back, and the receiver decline one", async () => {
    const t = await twoPlayers();
    await pick(t, "giveTo", `item:longsword>${heroes[1]?.id}`);
    await t.cards.sync(t.key);
    expect(contentOf(await t.press("offerCancel", "u-two", { argument: "offer:1", onCard: "offer:1" }))).toBe("That is not your hero.");
    expect(contentOf(await t.press("offerCancel", "u-org", { argument: "offer:1", onCard: "offer:1" }))).toBe("You took the offer back.");
    expect((await stateOf(t)).offers).toEqual({});
    expect((await stateOf(t)).characters[heroes[0]?.id ?? ""]?.equipment).toContain("item:longsword");

    await pick(t, "giveTo", `item:longsword>${heroes[1]?.id}`);
    await t.cards.sync(t.key);
    expect(contentOf(await t.press("offerNo", "u-two", { argument: "offer:2", onCard: "offer:2" }))).toBe("You declined the offer.");
    expect((await stateOf(t)).characters[heroes[1]?.id ?? ""]?.equipment).not.toContain("item:longsword");
  });

  it("offers nothing to do with the pack in a fight", async () => {
    const t = await harness();
    await started(t);
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(t.key);
      if (stored === undefined) throw new Error("state");
      await tx.saveCampaign(t.key, { ...stored.state, round: null }, stored.revision);
    });
    const spec = { id: "e", zones: [{ id: "z", name: "Yard" }], edges: [], partyZoneId: "z", monsters: [{ monsterId: "monster:goblin" as const, zoneId: "z", npcId: null, fleeBelowHpFraction: null }] };
    await t.r.bus.execute(t.key, { kind: "startEncounter", spec }, { commandId: "f", actor: { kind: "user", userId: "u-org" } });
    await t.cards.sync(t.key);
    expect(menuValues(await t.press("myHero", "u-org"), "pack")).toEqual([]);
  });
});

function flatText(messages: readonly { payload: unknown }[]): string {
  return messages.map((message) => JSON.stringify((message.payload as { toJSON?: () => unknown }).toJSON?.() ?? message.payload)).join(" ");
}
