import { describe, expect, it } from "vitest";

import { CampaignPlayController } from "../../../../src/application/campaign/campaign-play-controller.js";
import type { AccessPolicyService } from "../../../../src/application/access/access-policy-service.js";
import type { CampaignKey } from "../../../../src/application/campaign/ports/campaign-store.js";
import { enSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { CampaignAuthority } from "../../../../src/infrastructure/discord/campaign/campaign-authority.js";
import { CampaignCardService } from "../../../../src/infrastructure/discord/campaign/campaign-card-service.js";
import type { CampaignGameCreator, CreateGameResult } from "../../../../src/infrastructure/discord/campaign/campaign-game-creator.js";
import type { CampaignSetupService } from "../../../../src/infrastructure/discord/campaign/campaign-setup-service.js";
import { defaultWizardChoices, hubCustomId, parseHubId, parseWizardState, wizardState } from "../../../../src/infrastructure/discord/campaign/hub-ids.js";
import { CampaignHubComponentHandler } from "../../../../src/infrastructure/discord/components/campaign-hub-component-handler.js";
import { guildId, quiet, rig, startedCampaign, type Rig } from "../../../application/campaign/campaign-rig.js";
import { FakeMessages } from "./fake-messages.js";

const hubChannel = "chan-hub";
const adminRole = "role-admin";

interface Sent {
  kind: "reply" | "defer" | "deferUpdate" | "edit" | "modal" | "update";
  payload: unknown;
}

interface Who {
  userId: string;
  // Holds the DnD Admin role.
  admin?: boolean;
  // Is a bot administrator.
  botAdmin?: boolean;
}

// Just enough of a Discord interaction to drive the hub handler.
function fakeInteraction(input: Who & { customId: string; messageId?: string; values?: string[]; fields?: Record<string, string>; kind: "button" | "select" | "modal" }): { interaction: never; sent: Sent[] } {
  const sent: Sent[] = [];
  const interaction = {
    customId: input.customId,
    guildId,
    id: `i-${Math.random()}`,
    user: { id: input.userId },
    member: { roles: { cache: new Set(input.admin === true ? [adminRole] : []) } },
    message: { id: input.messageId ?? "" },
    values: input.values ?? [],
    botAdmin: input.botAdmin === true,
    inCachedGuild: (): boolean => true,
    isButton: (): boolean => input.kind === "button",
    isStringSelectMenu: (): boolean => input.kind === "select",
    reply: (payload: unknown): Promise<void> => (sent.push({ kind: "reply", payload }), Promise.resolve()),
    deferReply: (payload: unknown): Promise<void> => (sent.push({ kind: "defer", payload }), Promise.resolve()),
    deferUpdate: (): Promise<void> => (sent.push({ kind: "deferUpdate", payload: null }), Promise.resolve()),
    editReply: (payload: unknown): Promise<void> => (sent.push({ kind: "edit", payload }), Promise.resolve()),
    update: (payload: unknown): Promise<void> => (sent.push({ kind: "update", payload }), Promise.resolve()),
    showModal: (payload: unknown): Promise<void> => (sent.push({ kind: "modal", payload }), Promise.resolve()),
    fields: { getTextInputValue: (name: string): string => input.fields?.[name] ?? "" },
  };
  // The role cache is a Set of ids; the handler asks has(id) like discord.js' Collection.
  return { interaction: interaction as never, sent };
}

const contentOf = (sent: readonly Sent[]): string => {
  const last = [...sent].reverse().find((entry) => entry.kind === "edit" || entry.kind === "update" || entry.kind === "reply");
  return String((last?.payload as { content?: string } | undefined)?.content ?? "");
};

const rowsOf = (sent: readonly Sent[]): { customId: string; label: string; style?: number }[][] => {
  const last = [...sent].reverse().find((entry) => entry.kind === "edit" || entry.kind === "update" || entry.kind === "reply");
  const rows = (last?.payload as { components?: { toJSON(): { components: { custom_id: string; label?: string; placeholder?: string; style?: number }[] } }[] } | undefined)?.components ?? [];
  return rows.map((row) => row.toJSON().components.map((component) => ({ customId: component.custom_id, label: component.label ?? component.placeholder ?? "", ...(component.style === undefined ? {} : { style: component.style }) })));
};

interface Harness {
  r: Rig;
  messages: FakeMessages;
  cards: CampaignCardService;
  createCalls: unknown[];
  provisioned: CampaignKey[];
  click: (customId: string, who: Who, options?: { messageId?: string; values?: string[] }) => Promise<Sent[]>;
  submit: (customId: string, who: Who, name: string) => Promise<Sent[]>;
}

function harness(options: { modelConfigured?: boolean } = {}): Harness {
  const r = rig();
  const messages = new FakeMessages();
  const glossaries = { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary };
  const cards = new CampaignCardService({ unitOfWork: r.store, rulesets: r.rulesets, adventures: r.adventures, messages, glossaries, logger: quiet });
  const createCalls: unknown[] = [];
  const provisioned: CampaignKey[] = [];
  const creator = {
    modelConfigured: options.modelConfigured ?? true,
    create: (game: unknown): Promise<CreateGameResult> => {
      createCalls.push(game);
      return Promise.resolve({ kind: "refused", reason: "nameTaken" });
    },
  } as unknown as CampaignGameCreator;
  const setup = {
    provision: (key: CampaignKey): Promise<{ kind: "ok" }> => (provisioned.push(key), Promise.resolve({ kind: "ok" })),
  } as unknown as CampaignSetupService;
  // Only a marked interaction counts as a bot administrator.
  const access = { evaluate: (_policy: unknown, _module: unknown, interaction: { botAdmin?: boolean }): { allowed: boolean } => ({ allowed: interaction.botAdmin === true }) } as unknown as AccessPolicyService;
  const authority = new CampaignAuthority(access, r.store);
  const handler = new CampaignHubComponentHandler({
    lobby: r.service,
    play: new CampaignPlayController({ unitOfWork: r.store, bus: r.bus, refresher: cards, adventures: r.adventures }),
    setup,
    cards,
    creator,
    authority,
  });
  return {
    r,
    messages,
    cards,
    createCalls,
    provisioned,
    click: async (customId, who, opts = {}): Promise<Sent[]> => {
      const { interaction, sent } = fakeInteraction({ ...who, customId, ...(opts.messageId === undefined ? {} : { messageId: opts.messageId }), ...(opts.values === undefined ? {} : { values: opts.values }), kind: opts.values === undefined ? "button" : "select" });
      await handler.execute({ interaction, logger: quiet as never });
      return sent;
    },
    submit: async (customId, who, name): Promise<Sent[]> => {
      const { interaction, sent } = fakeInteraction({ ...who, customId, fields: { name }, kind: "modal" });
      await handler.executeModal({ interaction, logger: quiet as never });
      return sent;
    },
  };
}

async function withSettings(t: Harness): Promise<void> {
  await t.r.store.transaction((tx) => tx.saveGuildSettings({ guildId, categoryId: null, hubChannelId: hubChannel, hubCard: null, adminRoleId: adminRole }));
}

// An active game whose hub message is drawn.
async function activeGame(t: Harness): Promise<{ key: CampaignKey; hubMessageId: string }> {
  await withSettings(t);
  const key = await startedCampaign(t.r);
  await t.r.store.transaction(async (tx) => {
    const stored = await tx.loadRecord(key);
    if (stored === undefined) throw new Error("record");
    await tx.saveRecord({ ...stored.record, channels: { ...stored.record.channels, partyChannelId: "chan-party", adventureChannelId: "chan-adventure" } }, stored.revision);
  });
  await t.cards.sync(key);
  return { key, hubMessageId: (await t.r.service.get(key))?.record.cards.hub?.messageId ?? "" };
}

describe("hub custom IDs", () => {
  it("round-trips the wizard choices and falls back per field when they are tampered with", () => {
    const choices = { language: "zh-TW", pacing: "playByPost", players: 5 } as const;
    expect(parseWizardState(wizardState(choices))).toEqual(choices);
    expect(parseWizardState("fr.hourly.99")).toEqual(defaultWizardChoices);
    expect(parseWizardState(undefined)).toEqual(defaultWizardChoices);
    expect(parseWizardState("zh-TW.live.x")).toEqual({ language: "zh-TW", pacing: "live", players: 3 });
  });

  it("parses only the hub's own IDs", () => {
    expect(parseHubId(hubCustomId("do", "c1", "pause"))).toEqual({ action: "do", parts: ["c1", "pause"] });
    expect(parseHubId("dnd:join:c1")).toBeNull();
    expect(parseHubId("dndhub:nonsense")).toBeNull();
  });
});

describe("the Create game wizard", () => {
  it("is for DnD Admins and bot administrators only", async () => {
    const t = harness();
    await withSettings(t);
    expect(contentOf(await t.click("dndhub:create", { userId: "u-x" }))).toBe("Only DnD Admins can create games.");
    expect(rowsOf(await t.click("dndhub:create", { userId: "u-a", admin: true }))).toHaveLength(4);
    expect(rowsOf(await t.click("dndhub:create", { userId: "u-b", botAdmin: true }))).toHaveLength(4);
  });

  it("says so when no AI dungeon master is configured", async () => {
    const t = harness({ modelConfigured: false });
    await withSettings(t);
    expect(contentOf(await t.click("dndhub:create", { userId: "u-a", admin: true }))).toContain("CAMPAIGN_MODEL");
  });

  it("keeps the choices in the controls and switches language with the language choice", async () => {
    const t = harness();
    await withSettings(t);
    const start = wizardState(defaultWizardChoices);
    const chosen = await t.click(hubCustomId("wizLanguage", start), { userId: "u-a", admin: true }, { values: ["zh-TW"] });
    expect(contentOf(chosen)).toContain("新團務");
    const rows = rowsOf(chosen);
    expect(rows[0]?.[0]?.customId).toBe("dndhub:wizLanguage:zh-TW.live.3");
    const next = await t.click("dndhub:wizPlayers:zh-TW.live.3", { userId: "u-a", admin: true }, { values: ["5"] });
    expect(rowsOf(next).at(-1)?.[0]?.customId).toBe("dndhub:wizNext:zh-TW.live.5");
    const pace = await t.click("dndhub:wizPacing:zh-TW.live.5", { userId: "u-a", admin: true }, { values: ["playByPost"] });
    expect(rowsOf(pace).at(-1)?.[0]?.customId).toBe("dndhub:wizNext:zh-TW.playByPost.5");
  });

  it("opens the name form from Next and creates the game from it with the chosen settings", async () => {
    const t = harness();
    await withSettings(t);
    const modal = await t.click("dndhub:wizNext:zh-TW.playByPost.4", { userId: "u-a", admin: true });
    expect(modal[0]?.kind).toBe("modal");
    expect(JSON.stringify((modal[0]?.payload as { toJSON(): unknown }).toJSON())).toContain("dndhub:wizName:zh-TW.playByPost.4");

    await t.submit("dndhub:wizName:zh-TW.playByPost.4", { userId: "u-a", admin: true }, "月光遺跡");
    expect(t.createCalls).toEqual([{ guildId, organizerId: "u-a", name: "月光遺跡", language: "zh-TW", pacing: "playByPost", players: 4 }]);
  });

  it("creates nothing for someone who is not an admin, even with a valid form", async () => {
    const t = harness();
    await withSettings(t);
    const sent = await t.submit("dndhub:wizName:en.live.3", { userId: "u-x" }, "Sneaky");
    expect(t.createCalls).toEqual([]);
    expect(contentOf(sent)).toBe("Only DnD Admins can create games.");
  });
});

describe("Manage a game", () => {
  it("opens for the organizer and for a DnD Admin, and refuses everyone else", async () => {
    const t = harness();
    const { key, hubMessageId } = await activeGame(t);
    const id = hubCustomId("manage", key.campaignId);
    expect(contentOf(await t.click(id, { userId: "u-x" }, { messageId: hubMessageId }))).toBe("Only DnD Admins and the game's organizer can manage a game.");
    const organizer = await t.click(id, { userId: "u-org" }, { messageId: hubMessageId });
    expect(contentOf(organizer)).toContain("Manage Moonlit Ruins");
    expect(rowsOf(organizer).flat().map((button) => button.label)).toEqual(["Pause", "Close round", "Retry the DM", "Short rest", "Long rest", "Repair cards", "End game"]);
    expect(rowsOf(await t.click(id, { userId: "u-a", admin: true }, { messageId: hubMessageId })).flat()).toHaveLength(7);
  });

  it("refuses a Manage button on a message that is no longer the game's hub message", async () => {
    const t = harness();
    const { key } = await activeGame(t);
    expect(contentOf(await t.click(hubCustomId("manage", key.campaignId), { userId: "u-org" }, { messageId: "old" }))).toBe("That control is out of date. Use the newest message.");
  });

  it("lets a DnD Admin pause and resume a game they do not organize", async () => {
    const t = harness();
    const { key } = await activeGame(t);
    const admin = { userId: "u-a", admin: true };
    expect(contentOf(await t.click(hubCustomId("do", key.campaignId, "pause"), admin))).toContain("The campaign is paused");
    expect((await t.r.store.transaction((tx) => tx.loadCampaign(key)))?.state.pausedBy).toBe("organizer");
    // The view offers Resume now.
    const view = await t.click(hubCustomId("do", key.campaignId, "keep"), admin);
    expect(rowsOf(view).flat().map((button) => button.label)).toContain("Resume");
    expect(contentOf(await t.click(hubCustomId("do", key.campaignId, "resume"), admin))).toContain("Play continues");
    expect((await t.r.store.transaction((tx) => tx.loadCampaign(key)))?.state.pausedBy).toBeNull();
  });

  it("does nothing for a stranger who forges a control ID", async () => {
    const t = harness();
    const { key } = await activeGame(t);
    const sent = await t.click(hubCustomId("do", key.campaignId, "pause"), { userId: "u-x" });
    expect(contentOf(sent)).toBe("Only DnD Admins and the game's organizer can manage a game.");
    expect((await t.r.store.transaction((tx) => tx.loadCampaign(key)))?.state.pausedBy).toBeNull();
  });

  it("repairs a game's cards and channels", async () => {
    const t = harness();
    const { key } = await activeGame(t);
    const sent = await t.click(hubCustomId("do", key.campaignId, "repair"), { userId: "u-org" });
    expect(contentOf(sent)).toContain("checked and redrawn");
    expect(t.provisioned).toEqual([key]);
  });

  it("asks before ending a game, keeps it on No, and ends it for good on Yes", async () => {
    const t = harness();
    const { key } = await activeGame(t);
    const organizer = { userId: "u-org" };
    const ask = await t.click(hubCustomId("endAsk", key.campaignId), organizer);
    expect(contentOf(ask)).toContain("End **Moonlit Ruins** for good?");
    expect((await t.r.service.get(key))?.record.lifecycle).toBe("active");

    const kept = await t.click(hubCustomId("do", key.campaignId, "keep"), organizer);
    expect(contentOf(kept)).toContain("Nothing changed.");
    expect((await t.r.service.get(key))?.record.lifecycle).toBe("active");

    const ended = await t.click(hubCustomId("endYes", key.campaignId), organizer);
    expect(contentOf(ended)).toBe("**Moonlit Ruins** has ended.");
    expect((await t.r.service.get(key))?.record.lifecycle).toBe("archived");
    // The game stops: its clock is paused and its hub message is gone.
    expect((await t.r.store.transaction((tx) => tx.loadCampaign(key)))?.state.pausedBy).not.toBeNull();
    expect((await t.r.service.get(key))?.record.cards.hub).toBeUndefined();
  });

  it("does not let a stranger end a game", async () => {
    const t = harness();
    const { key } = await activeGame(t);
    await t.click(hubCustomId("endYes", key.campaignId), { userId: "u-x" });
    expect((await t.r.service.get(key))?.record.lifecycle).toBe("active");
  });

  it("says a game that no longer exists is gone", async () => {
    const t = harness();
    await withSettings(t);
    const sent = await t.click(hubCustomId("manage", "missing"), { userId: "u-org" }, { messageId: "m" });
    expect(contentOf(sent)).toBe("That game no longer exists.");
  });
});
