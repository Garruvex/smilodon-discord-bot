import { CampaignPlayController } from "../../../../src/application/campaign/campaign-play-controller.js";
import type { CampaignKey } from "../../../../src/application/campaign/ports/campaign-store.js";
import { enSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { starterAdventureId } from "../../../../src/infrastructure/campaign/starter-adventures.js";
import { CampaignCardService } from "../../../../src/infrastructure/discord/campaign/campaign-card-service.js";
import { CampaignComponentHandler } from "../../../../src/infrastructure/discord/components/campaign-component-handler.js";
import { guildId, quiet, rig, starter, tellOpening, type Rig } from "../../../application/campaign/campaign-rig.js";
import { FakeMessages } from "./fake-messages.js";

export const party = "chan-party";
export const adventure = "chan-adventure";
export const heroes = starter.en.heroes;

export interface Sent {
  kind: "reply" | "defer" | "edit" | "modal" | "update";
  payload: unknown;
}

// Just enough of a Discord interaction to drive the handler.
export function fakeInteraction(input: { customId: string; userId: string; messageId?: string; values?: string[]; fields?: Record<string, string>; kind: "button" | "select" | "modal" }): {
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
    deferUpdate: (): Promise<void> => {
      sent.push({ kind: "defer", payload: undefined });
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

export const contentOf = (sent: readonly Sent[]): string => {
  const last = [...sent].reverse().find((entry) => entry.kind === "edit" || entry.kind === "update" || entry.kind === "reply");
  return String((last?.payload as { content?: string } | undefined)?.content ?? "");
};

export interface Harness {
  r: Rig;
  messages: FakeMessages;
  cards: CampaignCardService;
  handler: CampaignComponentHandler;
  key: CampaignKey;
  press: (action: string, userId: string, options?: { argument?: string; onCard?: string }) => Promise<Sent[]>;
  select: (userId: string, heroId: string) => Promise<Sent[]>;
  submit: (userId: string, text: string) => Promise<Sent[]>;
}

export async function harness(language: "en" | "zh-TW" = "en"): Promise<Harness> {
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

export async function started(t: Harness): Promise<void> {
  await t.press("join", "u-org");
  await t.select("u-org", heroes[0]?.id ?? "");
  await t.press("start", "u-org");
  await tellOpening(t.r, t.key);
}

