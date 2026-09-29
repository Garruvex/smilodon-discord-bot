import { describe, expect, it } from "vitest";

import type { CampaignState } from "../../../../src/domain/campaign/state/campaign-state.js";
import { quiet, starter, tellOpening } from "../../../application/campaign/campaign-rig.js";
import { alex, jamie, newCampaign, organizer as fightOrganizer, partyOfThree, sam } from "../../../domain/campaign/campaign-fixtures.js";
import { Fight, skirmish } from "../../../domain/campaign/combat-fixtures.js";
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

  it("refuses a form opened in an earlier round, and takes one for the round that is open", async () => {
    const t = await harness();
    await started(t);
    const round = (await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state.round?.number ?? 0;
    const opened = await t.press("act", "u-org");
    expect(JSON.stringify(opened[0]?.payload)).toContain(`dnd:act:${t.key.campaignId}:${round}`);
    // Nobody acts, so the organizer closes a quiet round and the next one opens.
    await t.r.bus.execute(t.key, { kind: "closeRound" }, { commandId: "close-1", actor: { kind: "user", userId: "u-org" } });
    expect((await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state.round?.number).toBe(round + 1);

    const submit = async (forRound: number): Promise<Sent[]> => {
      const { interaction, sent } = fakeInteraction({ customId: `dnd:act:${t.key.campaignId}:${forRound}`, userId: "u-org", fields: { action: "I search the room." }, kind: "modal" });
      await t.handler.executeModal({ interaction, logger: quiet as never });
      return sent;
    };
    expect(contentOf(await submit(round))).toBe("That form was for an earlier round. Press Act to open a fresh one.");
    expect((await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state.round?.submissions[heroes[0]?.id ?? ""]).toBeUndefined();
    expect(contentOf(await submit(round + 1))).toBe("Your action is saved. You can change it until the round closes.");
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
    // Coming back also catches you up.
    const back = contentOf(await t.press("back", "u-org"));
    expect(back).toContain("Welcome back. You rejoin at the next round.");
    expect(back).toContain("**Story so far**");
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

describe("a Shield reaction", () => {
  // Grafts a real, mid-reaction combat state from the low-level engine
  // harness onto a normal campaign: the reaction view and the engine's own
  // command handling only need the state to be internally consistent, not
  // the same heroes this campaign started with (the domain layer's own
  // tests/domain/campaign/reactions.test.ts already covers the mechanics;
  // this only exercises the Discord-facing card and button wiring).
  async function reactionPending(t: Awaited<ReturnType<typeof harness>>): Promise<void> {
    const base = partyOfThree();
    const elspeth = base.characters["c-elspeth"];
    const casting = elspeth?.spellcasting;
    if (elspeth === undefined || casting === undefined || casting === null) throw new Error("fixture");
    const wizardParty = { ...base, characters: { ...base.characters, "c-elspeth": { ...elspeth, spellcasting: { ...casting, spells: [...casting.spells, "spell:shield" as const] } } } };
    const fight = new Fight(wizardParty)
      .rolls([5, 4, 20, 3, 2])
      .run(fightOrganizer, { kind: "startEncounter", spec: skirmish })
      .run(sam, { kind: "endTurn", combatantId: "c-elspeth" })
      .rolls([15])
      .run(alex, { kind: "endTurn", combatantId: "c-mira" });
    expect(fight.encounter.resolution?.reaction).toMatchObject({ targetId: "c-elspeth" });
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(t.key);
      if (stored === undefined) throw new Error("campaign");
      await tx.saveCampaign(t.key, fight.state, stored.revision);
    });
    await t.cards.sync(t.key);
  }

  // The reaction card's own buttons, distinct from the adventure panel that
  // sits below it (which also names every hero present, Elspeth included).
  const reactionCard = (t: Awaited<ReturnType<typeof harness>>): { payload: unknown } | undefined =>
    t.messages.live(adventure).find((message) => flatText([message]).includes(`dnd:reactCast:${t.key.campaignId}:spell:shield`));

  it("shows a card for the hit, answered only by the target's own player", async () => {
    const t = await harness();
    await started(t);
    await reactionPending(t);
    expect(reactionCard(t)).toBeDefined();

    // "u-org" has no hero in this grafted state at all (a stranger clicking it).
    expect(contentOf(await t.press("reactCast", "u-org", { argument: "spell:shield", onCard: "reaction" }))).toBe("You do not have a hero in this campaign.");
  });

  it("turns the hit into a miss when cast, and clears the card", async () => {
    const t = await harness();
    await started(t);
    await reactionPending(t);

    expect(contentOf(await t.press("reactCast", "u-sam", { argument: "spell:shield", onCard: "reaction" }))).toBe("You cast it.");
    const after = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    expect(after?.state.characters["c-elspeth"]).toBeDefined();
    expect(after?.state.encounter?.resolution?.reaction).toBeUndefined();

    await t.cards.sync(t.key);
    expect(reactionCard(t)).toBeUndefined();
  });

  it("takes the hit when declined, and clears the card", async () => {
    const t = await harness();
    await started(t);
    await reactionPending(t);

    // Damage isn't rolled synchronously here (this rig has no RollWorker
    // running; the roll lands via the same recordRoll path any other pending
    // check does, covered at the domain layer's own reactions.test.ts). What
    // this checks is that the click itself is accepted and clears the window.
    expect(contentOf(await t.press("reactDecline", "u-sam", { onCard: "reaction" }))).toBe("You took the hit.");
    const after = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    expect(after?.state.encounter?.resolution?.reaction).toBeFalsy();

    await t.cards.sync(t.key);
    expect(reactionCard(t)).toBeUndefined();
  });
});

describe("a smite window", () => {
  // Same approach as "a Shield reaction" above: graft a real, engine-verified
  // mid-smite CampaignState onto a Discord-harness campaign, then drive the
  // real component handler and play controller against it.
  async function smitePending(t: Awaited<ReturnType<typeof harness>>): Promise<void> {
    const base = newCampaign();
    const borin = base.characters["c-borin"];
    if (borin === undefined) throw new Error("fixture");
    const smiter = { ...borin, features: [...borin.features, "feature:divine-smite" as const], spellcasting: { ability: "cha" as const, spells: [], slots: { 1: 1 } } };
    const state = { ...base, characters: { ...base.characters, "c-borin": smiter } };
    const fight = new Fight(state)
      .rolls([1, 20, 5, 4])
      .run(fightOrganizer, { kind: "startEncounter", spec: skirmish })
      .run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" })
      .run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-a" })
      .rolls([20])
      .run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-a", weapon: "item:longsword" });
    expect(fight.encounter.resolution?.smite).toMatchObject({ targetId: "goblin-a" });
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(t.key);
      if (stored === undefined) throw new Error("campaign");
      await tx.saveCampaign(t.key, fight.state, stored.revision);
    });
    await t.cards.sync(t.key);
  }

  const smiteCard = (t: Awaited<ReturnType<typeof harness>>): { payload: unknown } | undefined =>
    t.messages.live(adventure).find((message) => flatText([message]).includes(`dnd:smiteChoose:${t.key.campaignId}:1`));

  it("shows a card for the landed hit, answered only by the attacker's own player", async () => {
    const t = await harness();
    await started(t);
    await smitePending(t);
    expect(smiteCard(t)).toBeDefined();

    expect(contentOf(await t.press("smiteChoose", "u-org", { argument: "1", onCard: "smite" }))).toBe("You do not have a hero in this campaign.");
  });

  it("spends the slot and clears the card when chosen", async () => {
    const t = await harness();
    await started(t);
    await smitePending(t);

    expect(contentOf(await t.press("smiteChoose", "u-jamie", { argument: "1", onCard: "smite" }))).toBe("You smote it.");
    const after = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    expect(after?.state.encounter?.resolution?.smite).toBeFalsy();
    expect(after?.state.encounter?.combatants["c-borin"]?.resources.spellSlots).toEqual({ 1: 0 });

    await t.cards.sync(t.key);
    expect(smiteCard(t)).toBeUndefined();
  });

  it("spends nothing and clears the card when skipped", async () => {
    const t = await harness();
    await started(t);
    await smitePending(t);

    expect(contentOf(await t.press("smiteSkip", "u-jamie", { onCard: "smite" }))).toBe("You skipped it.");
    const after = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    expect(after?.state.encounter?.resolution?.smite).toBeFalsy();
    expect(after?.state.encounter?.combatants["c-borin"]?.resources.spellSlots).toEqual({ 1: 1 });

    await t.cards.sync(t.key);
    expect(smiteCard(t)).toBeUndefined();
  });
});

describe("an opportunity attack", () => {
  // Same approach as "a Shield reaction" above: graft a real, engine-verified
  // mid-move-with-offer CampaignState onto a Discord-harness campaign, then
  // drive the real component handler and play controller against it. Borin
  // engages a skeleton (no Nimble Escape), which then retreats to shoot,
  // provoking Borin's reaction (tests/domain/campaign/combat-features.test.ts
  // already covers the mechanics; this only exercises the Discord wiring).
  async function opportunityPending(t: Awaited<ReturnType<typeof harness>>): Promise<void> {
    const close = { ...skirmish, zones: [...skirmish.zones, { id: "tower", name: "Tower" }], edges: [...skirmish.edges, { from: "courtyard", to: "tower", feet: 10 }] };
    const closeSkeleton = { ...close, monsters: [{ monsterId: "monster:skeleton" as const, zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null }] };
    const fight = new Fight()
      .rolls([1, 20, 5])
      .run(fightOrganizer, { kind: "startEncounter", spec: closeSkeleton })
      .run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" })
      .run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "skeleton" })
      .run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    expect(fight.encounter.pendingMove).toMatchObject({ combatantId: "skeleton", provokers: ["c-borin"] });
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(t.key);
      if (stored === undefined) throw new Error("campaign");
      await tx.saveCampaign(t.key, fight.state, stored.revision);
    });
    await t.cards.sync(t.key);
  }

  const opportunityCard = (t: Awaited<ReturnType<typeof harness>>): { payload: unknown } | undefined =>
    t.messages.live(adventure).find((message) => flatText([message]).includes(`dnd:opportunityTake:${t.key.campaignId}`));

  it("shows a card for the retreat, answered only by the provoker's own player", async () => {
    const t = await harness();
    await started(t);
    await opportunityPending(t);
    expect(opportunityCard(t)).toBeDefined();

    expect(contentOf(await t.press("opportunityTake", "u-org", { onCard: "opportunity" }))).toBe("You do not have a hero in this campaign.");
  });

  it("takes the attack and clears the card when taken", async () => {
    const t = await harness();
    await started(t);
    await opportunityPending(t);

    // The attack roll itself isn't resolved synchronously here (this rig has
    // no RollWorker running; the roll lands via the same recordRoll path any
    // other pending check does, covered at the domain layer's own
    // combat-features.test.ts). What this checks is that the click is
    // accepted and the decision window itself closes.
    expect(contentOf(await t.press("opportunityTake", "u-jamie", { onCard: "opportunity" }))).toBe("You took the attack.");
    const after = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    expect(after?.state.encounter?.pendingMove?.offer).toBeFalsy();
    expect(after?.state.encounter?.pendingMove?.provokers).toEqual([]);

    await t.cards.sync(t.key);
    expect(opportunityCard(t)).toBeUndefined();
  });

  it("holds the reaction and clears the card when declined", async () => {
    const t = await harness();
    await started(t);
    await opportunityPending(t);

    expect(contentOf(await t.press("opportunityHold", "u-jamie", { onCard: "opportunity" }))).toBe("You held your reaction.");
    const after = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    expect(after?.state.encounter?.pendingMove).toBeFalsy();
    expect(after?.state.encounter?.combatants["c-borin"]?.budget.reaction).toBe(true);

    await t.cards.sync(t.key);
    expect(opportunityCard(t)).toBeUndefined();
  });
});

describe("an Ability Score Improvement owed on My Hero", () => {
  const buttonIds = (sent: readonly Sent[]): string[] => {
    const last = [...sent].reverse().find((entry) => entry.kind === "edit");
    const rows = (last?.payload as { components?: { toJSON(): { components: { custom_id?: string; url?: string }[] } }[] } | undefined)?.components ?? [];
    return rows.flatMap((row) => row.toJSON().components.map((component) => component.custom_id ?? component.url ?? ""));
  };

  async function withPendingAsi(t: Awaited<ReturnType<typeof harness>>, pendingAsi = 1): Promise<{ heroId: string; str: number }> {
    await started(t);
    const stored = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    if (stored === undefined) throw new Error("state");
    const heroId = stored.state.members["u-org"]?.characterId;
    const sheet = heroId === null || heroId === undefined ? undefined : stored.state.characters[heroId];
    if (heroId === null || heroId === undefined || sheet === undefined) throw new Error("hero");
    await t.r.store.transaction(async (tx) => {
      const latest = await tx.loadCampaign(t.key);
      if (latest === undefined) throw new Error("state");
      await tx.saveCampaign(t.key, { ...latest.state, characters: { ...latest.state.characters, [heroId]: { ...sheet, pendingAsi } } }, latest.revision);
    });
    return { heroId, str: sheet.abilityScores.str };
  }

  it("offers the picker only when one is owed", async () => {
    const t = await harness();
    await started(t);
    expect(buttonIds(await t.press("myHero", "u-org")).some((id) => id.startsWith("dnd:asiOpen:"))).toBe(false);
    await withPendingAsi(t);
    expect(buttonIds(await t.press("myHero", "u-org")).some((id) => id.startsWith("dnd:asiOpen:"))).toBe(true);
  });

  it("refuses to open the picker once nothing is owed", async () => {
    const t = await harness();
    await started(t);
    expect(contentOf(await t.press("asiOpen", "u-org"))).toBe("This hero has no Ability Score Improvement to spend right now.");
  });

  it("adds +2 to one ability and clears the pending improvement", async () => {
    const t = await harness();
    const { heroId, str } = await withPendingAsi(t);
    const picked = fakeInteraction({ customId: `dnd:asiPick:${t.key.campaignId}`, userId: "u-org", values: ["str"], kind: "select" });
    await t.handler.execute({ interaction: picked.interaction, logger: quiet as never });
    expect(contentOf(picked.sent)).toContain(`Ability score improved: Strength ${str} → ${str + 2}`);
    const after = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    expect(after?.state.characters[heroId]?.abilityScores.str).toBe(str + 2);
    expect(after?.state.characters[heroId]?.pendingAsi).toBe(0);
  });

  it("adds +1 to two different abilities", async () => {
    const t = await harness();
    const { heroId } = await withPendingAsi(t);
    const stored = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    const before = stored?.state.characters[heroId]?.abilityScores;
    const picked = fakeInteraction({ customId: `dnd:asiPick:${t.key.campaignId}`, userId: "u-org", values: ["dex", "wis"], kind: "select" });
    await t.handler.execute({ interaction: picked.interaction, logger: quiet as never });
    const after = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    expect(after?.state.characters[heroId]?.abilityScores.dex).toBe((before?.dex ?? 0) + 1);
    expect(after?.state.characters[heroId]?.abilityScores.wis).toBe((before?.wis ?? 0) + 1);
    expect(after?.state.characters[heroId]?.pendingAsi).toBe(0);
  });

  it("refuses the same ability picked twice", async () => {
    const t = await harness();
    await withPendingAsi(t);
    const picked = fakeInteraction({ customId: `dnd:asiPick:${t.key.campaignId}`, userId: "u-org", values: ["str", "str"], kind: "select" });
    await t.handler.execute({ interaction: picked.interaction, logger: quiet as never });
    expect(contentOf(picked.sent)).toBe("Pick one ability, or two different ones.");
  });

  it("stacks two owed improvements as two separate spends", async () => {
    const t = await harness();
    const { heroId, str } = await withPendingAsi(t, 2);
    const first = fakeInteraction({ customId: `dnd:asiPick:${t.key.campaignId}`, userId: "u-org", values: ["str"], kind: "select" });
    await t.handler.execute({ interaction: first.interaction, logger: quiet as never });
    const middle = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    expect(middle?.state.characters[heroId]?.pendingAsi).toBe(1);
    expect(middle?.state.characters[heroId]?.abilityScores.str).toBe(str + 2);

    const second = fakeInteraction({ customId: `dnd:asiPick:${t.key.campaignId}`, userId: "u-org", values: ["con"], kind: "select" });
    await t.handler.execute({ interaction: second.interaction, logger: quiet as never });
    const after = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    expect(after?.state.characters[heroId]?.pendingAsi).toBe(0);
  });
});

describe("speaking, the safety pause, and the help menu", () => {
  const stateOf = async (t: Awaited<ReturnType<typeof harness>>): Promise<CampaignState> => {
    const stored = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    if (stored === undefined) throw new Error("state");
    return stored.state;
  };
  const buttonIds = (sent: readonly Sent[]): string[] => {
    const last = [...sent].reverse().find((entry) => entry.kind === "edit");
    const rows = (last?.payload as { components?: { toJSON(): { components: { custom_id?: string; url?: string }[] } }[] } | undefined)?.components ?? [];
    return rows.flatMap((row) => row.toJSON().components.map((component) => component.custom_id ?? component.url ?? ""));
  };

  it("opens a form for Speak, then posts the words as the hero without spending the action", async () => {
    const t = await harness();
    await started(t);
    const opened = await t.press("speak", "u-org");
    expect(opened.some((entry) => entry.kind === "modal")).toBe(true);

    const { interaction, sent } = fakeInteraction({ customId: `dnd:speak:${t.key.campaignId}`, userId: "u-org", fields: { action: "  Quiet, now.  " }, kind: "modal" });
    await t.handler.executeModal({ interaction, logger: quiet as never });
    expect(contentOf(sent)).toBe("Posted.");
    const events = (await t.r.store.transaction((tx) => tx.readEvents(t.key))).map((envelope) => envelope.event);
    expect(events.findLast((event) => event.kind === "heroSpoke")).toMatchObject({ text: "Quiet, now." });
    // Still free to act.
    expect(contentOf(await t.submit("u-org", "I open the door."))).toBe("Your action is saved. You can change it until the round closes.");
  });

  it("refuses empty words privately and speech from a stranger", async () => {
    const t = await harness();
    await started(t);
    const empty = fakeInteraction({ customId: `dnd:speak:${t.key.campaignId}`, userId: "u-org", fields: { action: "   " }, kind: "modal" });
    await t.handler.executeModal({ interaction: empty.interaction, logger: quiet as never });
    expect(contentOf(empty.sent)).toBe("Write what your hero does first.");
    const stranger = fakeInteraction({ customId: `dnd:speak:${t.key.campaignId}`, userId: "u-stranger", fields: { action: "Hello" }, kind: "modal" });
    await t.handler.executeModal({ interaction: stranger.interaction, logger: quiet as never });
    expect(contentOf(stranger.sent)).toBe("You do not have a hero in this campaign.");
  });

  it("asks before pausing for safety, then pauses the game for everyone", async () => {
    const t = await harness();
    await started(t);
    const asked = await t.press("safety", "u-org");
    expect(contentOf(asked)).toContain("Nobody at the table is told who asked");
    expect(buttonIds(asked)).toEqual([`dnd:safetyPause:${t.key.campaignId}`]);
    // Asking pauses nothing yet.
    expect((await stateOf(t)).pausedBy).toBeNull();

    const { interaction, sent } = fakeInteraction({ customId: `dnd:safetyPause:${t.key.campaignId}`, userId: "u-org", kind: "button" });
    await t.handler.execute({ interaction, logger: quiet as never });
    expect(contentOf(sent)).toBe("The game is paused.");
    expect(await stateOf(t)).toMatchObject({ pausedBy: "safety", status: "waitingForPlayers" });
    await t.cards.sync(t.key);
    expect(flatText(t.messages.live(adventure))).toContain("paused at a player");
  });

  it("does not let an outsider pause the game", async () => {
    const t = await harness();
    await started(t);
    const { interaction, sent } = fakeInteraction({ customId: `dnd:safetyPause:${t.key.campaignId}`, userId: "u-stranger", kind: "button" });
    await t.handler.execute({ interaction, logger: quiet as never });
    expect(contentOf(sent)).not.toBe("The game is paused.");
    expect((await stateOf(t)).pausedBy).toBeNull();
  });

  it("explains the controls and links to the Party channel from More", async () => {
    const t = await harness();
    await started(t);
    const more = await t.press("more", "u-org");
    expect(contentOf(more)).toContain("How to play");
    expect(buttonIds(more)).toEqual([`dnd:journal:${t.key.campaignId}`, `dnd:recap:${t.key.campaignId}`, `https://discord.com/channels/g-1/chan-party`]);
  });

  it("keeps Safety and More on the panel in every running state", async () => {
    const t = await harness();
    await started(t);
    const text = (): string => flatText(t.messages.live(adventure));
    await t.cards.sync(t.key);
    expect(text()).toContain(`dnd:safety:${t.key.campaignId}`);
    expect(text()).toContain(`dnd:more:${t.key.campaignId}`);
  });
});

function flatText(messages: readonly { payload: unknown }[]): string {
  return messages.map((message) => JSON.stringify((message.payload as { toJSON?: () => unknown }).toJSON?.() ?? message.payload)).join(" ");
}
