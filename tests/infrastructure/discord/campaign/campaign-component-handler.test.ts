import { describe, expect, it } from "vitest";

import { CampaignPlayController } from "../../../../src/application/campaign/campaign-play-controller.js";
import type { CampaignKey } from "../../../../src/application/campaign/ports/campaign-store.js";
import { enSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { starterAdventureId } from "../../../../src/infrastructure/campaign/starter-adventures.js";
import { CampaignCardService } from "../../../../src/infrastructure/discord/campaign/campaign-card-service.js";
import { CampaignComponentHandler } from "../../../../src/infrastructure/discord/components/campaign-component-handler.js";
import { guildId, quiet, rig, starter, type Rig } from "../../../application/campaign/campaign-rig.js";
import { FakeMessages } from "./fake-messages.js";

const party = "chan-party";
const adventure = "chan-adventure";
const heroes = starter.en.heroes;

interface Sent {
  kind: "reply" | "defer" | "edit" | "modal" | "update";
  payload: unknown;
}

// Just enough of a Discord interaction to drive the handler.
function fakeInteraction(input: { customId: string; userId: string; messageId?: string; values?: string[]; fields?: Record<string, string>; kind: "button" | "select" | "modal" }): {
  interaction: never;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const interaction = {
    customId: input.customId,
    guildId,
    id: `i-${Math.random()}`,
    user: { id: input.userId },
    message: { id: input.messageId ?? "" },
    values: input.values ?? [],
    isButton: (): boolean => input.kind === "button",
    isStringSelectMenu: (): boolean => input.kind === "select",
    reply: (payload: unknown): Promise<void> => {
      sent.push({ kind: "reply", payload });
      return Promise.resolve();
    },
    deferReply: (payload: unknown): Promise<void> => {
      sent.push({ kind: "defer", payload });
      return Promise.resolve();
    },
    editReply: (payload: unknown): Promise<void> => {
      sent.push({ kind: "edit", payload });
      return Promise.resolve();
    },
    update: (payload: unknown): Promise<void> => {
      sent.push({ kind: "update", payload });
      return Promise.resolve();
    },
    showModal: (payload: unknown): Promise<void> => {
      sent.push({ kind: "modal", payload });
      return Promise.resolve();
    },
    fields: { getTextInputValue: (name: string): string => input.fields?.[name] ?? "" },
  };
  return { interaction: interaction as never, sent };
}

const contentOf = (sent: readonly Sent[]): string => {
  const last = [...sent].reverse().find((entry) => entry.kind === "edit" || entry.kind === "update" || entry.kind === "reply");
  return String((last?.payload as { content?: string } | undefined)?.content ?? "");
};

interface Harness {
  r: Rig;
  messages: FakeMessages;
  cards: CampaignCardService;
  handler: CampaignComponentHandler;
  key: CampaignKey;
  press: (action: string, userId: string, options?: { argument?: string; onCard?: string }) => Promise<Sent[]>;
  select: (userId: string, heroId: string) => Promise<Sent[]>;
  submit: (userId: string, text: string) => Promise<Sent[]>;
}

async function harness(language: "en" | "zh-TW" = "en"): Promise<Harness> {
  const r = rig();
  const messages = new FakeMessages();
  const glossaries = { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary };
  const cards = new CampaignCardService({ unitOfWork: r.store, rulesets: r.rulesets, adventures: r.adventures, messages, glossaries, logger: quiet });
  const handler = new CampaignComponentHandler({
    lobby: r.service,
    play: new CampaignPlayController({ unitOfWork: r.store, bus: r.bus, refresher: cards, adventures: r.adventures }),
    cards,
    unitOfWork: r.store,
    rulesets: r.rulesets,
    adventures: r.adventures,
    glossaries,
  });
  const created = await r.service.create({ guildId, organizerId: "u-org", name: "Moonlit Ruins", language, adventureId: starterAdventureId, pacing: { preset: "live" } });
  if (created.kind !== "ok") throw new Error("create");
  const key = created.value.key;
  await r.store.transaction(async (tx) => {
    const stored = await tx.loadRecord(key);
    if (stored === undefined) throw new Error("record");
    await tx.saveRecord({ ...stored.record, channels: { ...stored.record.channels, partyChannelId: party, adventureChannelId: adventure } }, stored.revision);
  });
  await cards.sync(key);
  const messageFor = async (card: string): Promise<string> => (await r.service.get(key))?.record.cards[card]?.messageId ?? "stale";
  return {
    r,
    messages,
    cards,
    handler,
    key,
    press: async (action, userId, options = {}): Promise<Sent[]> => {
      const card = options.onCard ?? (["join", "pickHero", "leave", "start"].includes(action) ? ((await r.service.get(key))?.record.lifecycle === "lobby" ? "lobby" : "party") : "adventure");
      const argument = options.argument === undefined ? "" : `:${options.argument}`;
      const { interaction, sent } = fakeInteraction({ customId: `dnd:${action}:${key.campaignId}${argument}`, userId, messageId: await messageFor(card), kind: "button" });
      await handler.execute({ interaction, logger: quiet as never });
      return sent;
    },
    select: async (userId, heroId): Promise<Sent[]> => {
      const { interaction, sent } = fakeInteraction({ customId: `dnd:heroChoice:${key.campaignId}`, userId, values: [heroId], kind: "select" });
      await handler.execute({ interaction, logger: quiet as never });
      return sent;
    },
    submit: async (userId, text): Promise<Sent[]> => {
      const { interaction, sent } = fakeInteraction({ customId: `dnd:act:${key.campaignId}`, userId, fields: { action: text }, kind: "modal" });
      await handler.executeModal({ interaction, logger: quiet as never });
      return sent;
    },
  };
}

async function started(t: Harness): Promise<void> {
  await t.press("join", "u-org");
  await t.select("u-org", heroes[0]?.id ?? "");
  await t.press("start", "u-org");
}

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
