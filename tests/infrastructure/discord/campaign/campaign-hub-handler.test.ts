import { applicationIcons } from "../../../../src/infrastructure/discord/campaign/campaign-icons.js";
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
function fakeInteraction(
  input: Who & {
    customId: string;
    messageId?: string;
    values?: string[];
    fields?: Record<string, string>;
    selects?: Record<string, string[]>;
    uploads?: Record<string, { url: string; size: number }[]>;
    locale?: string;
    kind: "button" | "select" | "modal";
  },
): { interaction: never; sent: Sent[] } {
  const sent: Sent[] = [];
  const interaction = {
    customId: input.customId,
    locale: input.locale ?? "en-US",
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
    fields: {
      getTextInputValue: (name: string): string => input.fields?.[name] ?? "",
      getStringSelectValues: (name: string): string[] => input.selects?.[name] ?? [],
      getUploadedFiles: (name: string): { first: () => { url: string; size: number } | undefined } | null => {
        const files = input.uploads?.[name];
        return files === undefined ? null : { first: () => files[0] };
      },
    },
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
  // A form with any mix of text, menu and uploaded-file answers.
  form: (customId: string, who: Who, answers: { fields?: Record<string, string>; selects?: Record<string, string[]>; uploads?: Record<string, { url: string; size: number }[]>; locale?: string }) => Promise<Sent[]>;
  library: { imports: { userId: string; language: string; file: { url: string; size: number } | null }[] };
  intake: { uploads: { guildId: string; file: { url: string; size: number } | null }[]; authors: { guildId: string; input: unknown }[] };
}

function harness(options: { modelConfigured?: boolean; launcher?: boolean; canAuthor?: boolean; images?: boolean; icons?: boolean; guildLanguage?: "en" | "zh-TW"; catalog?: readonly { id: string; version: string; languages: ("en" | "zh-TW")[]; titles: Partial<Record<"en" | "zh-TW", string>> }[] } = {}): Harness {
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
    repair: (key: CampaignKey): Promise<{ kind: "ok"; requeued: number }> => (provisioned.push(key), Promise.resolve({ kind: "ok", requeued: 0 })),
  } as unknown as CampaignSetupService;
  // Only a marked interaction counts as a bot administrator.
  const access = { evaluate: (_policy: unknown, _module: unknown, interaction: { botAdmin?: boolean }): { allowed: boolean } => ({ allowed: interaction.botAdmin === true }), guildLanguage: (_guildId: string): "en" | "zh-TW" => options.guildLanguage ?? "en" } as unknown as AccessPolicyService;
  const authority = new CampaignAuthority(access, r.store);
  const library: Harness["library"] = { imports: [] };
  const intake: Harness["intake"] = { uploads: [], authors: [] };
  const launcher =
    options.launcher === false
      ? {}
      : {
          libraryScreens: {
            homeScreen: (userId: string, language: string): Promise<{ content: string; components: never[] }> => Promise.resolve({ content: `home of ${userId} in ${language}`, components: [] }),
            builderScreen: (language: string): { content: string; components: never[] } => ({ content: `builder in ${language}`, components: [] }),
            importFromFile: (userId: string, language: string, file: { url: string; size: number } | null): Promise<string> => (library.imports.push({ userId, language, file }), Promise.resolve("imported it")),
          },
          intake: {
            canAuthor: options.canAuthor ?? true,
            uploadFile: (ctx: { guildId: string; editReply: (payload: { content: string }) => Promise<unknown> }, file: { url: string; size: number } | null): Promise<void> => (intake.uploads.push({ guildId: ctx.guildId, file }), ctx.editReply({ content: "under review" }).then(() => undefined)),
            authorFrom: (ctx: { guildId: string; editReply: (payload: { content: string }) => Promise<unknown> }, input: unknown): Promise<void> => (intake.authors.push({ guildId: ctx.guildId, input }), ctx.editReply({ content: "written" }).then(() => undefined)),
          },
        };
  const handler = new CampaignHubComponentHandler({
    ...(launcher as object),
    lobby: r.service,
    play: new CampaignPlayController({ unitOfWork: r.store, bus: r.bus, refresher: cards, adventures: r.adventures }),
    setup,
    cards,
    creator,
    authority,
    ...(options.images === undefined ? {} : { imagesEnabled: options.images }),
    ...(options.catalog === undefined ? {} : { adventures: { listForGuild: (): NonNullable<typeof options.catalog> => options.catalog ?? [] } }),
    ...(options.icons === true ? { icons: applicationIcons((name) => ({ id: `id-${name}`, name })) } : {}),
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
    library,
    intake,
    form: async (customId, who, answers): Promise<Sent[]> => {
      const { interaction, sent } = fakeInteraction({ ...who, customId, ...answers, kind: "modal" });
      await handler.executeModal({ interaction, logger: quiet as never });
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
    await tx.saveRecord({ ...stored.record, channels: { ...stored.record.channels, partyPostId: "chan-party", adventurePostId: "chan-adventure" } }, stored.revision);
  });
  await t.cards.sync(key);
  return { key, hubMessageId: (await t.r.service.get(key))?.record.cards.hub?.messageId ?? "" };
}

describe("hub custom IDs", () => {
  it("round-trips the wizard choices and falls back per field when they are tampered with", () => {
    const choices = { language: "zh-TW", pacing: "playByPost", players: 5, loot: "split", visibility: "open", adventure: null } as const;
    expect(parseWizardState(wizardState(choices))).toEqual(choices);
    // Players-only is a fifth field, and a control made without it still parses as open.
    expect(wizardState({ ...choices, visibility: "membersOnly" })).toBe("zh-TW.playByPost.5.split.players");
    expect(parseWizardState("zh-TW.playByPost.5.split.players")).toEqual({ ...choices, visibility: "membersOnly" });
    expect(parseWizardState("zh-TW.playByPost.5.split")).toEqual(choices);
    expect(parseWizardState("fr.hourly.99")).toEqual(defaultWizardChoices);
    expect(parseWizardState(undefined)).toEqual(defaultWizardChoices);
    expect(parseWizardState("zh-TW.live.x")).toEqual({ language: "zh-TW", pacing: "live", players: 3, loot: "pooled", visibility: "open", adventure: null });
    // A chosen adventure is a sixth field, which needs the fifth in front of it.
    const chosen = { ...choices, adventure: "g6d5494-harbor-heist" } as const;
    expect(wizardState(chosen)).toBe("zh-TW.playByPost.5.split.open.g6d5494-harbor-heist");
    expect(parseWizardState(wizardState(chosen))).toEqual(chosen);
    expect(parseWizardState("en.live.3.pooled.open.BAD ID")).toMatchObject({ adventure: null });
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
    expect(rowsOf(await t.click("dndhub:create", { userId: "u-a", admin: true }))).toHaveLength(5);
    expect(rowsOf(await t.click("dndhub:create", { userId: "u-b", botAdmin: true }))).toHaveLength(5);
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
    expect(rows[0]?.[0]?.customId).toBe("dndhub:wizLanguage:zh-TW.live.3.pooled");
    const next = await t.click("dndhub:wizPlayers:zh-TW.live.3.pooled", { userId: "u-a", admin: true }, { values: ["5"] });
    expect(rowsOf(next).at(-1)?.[0]?.customId).toBe("dndhub:wizNext:zh-TW.live.5.pooled");
    const pace = await t.click("dndhub:wizPacing:zh-TW.live.5.pooled", { userId: "u-a", admin: true }, { values: ["playByPost"] });
    expect(rowsOf(pace).at(-1)?.[0]?.customId).toBe("dndhub:wizNext:zh-TW.playByPost.5.pooled");
    const loot = await t.click("dndhub:wizLoot:zh-TW.playByPost.5.pooled", { userId: "u-a", admin: true }, { values: ["split"] });
    expect(rowsOf(loot).at(-1)?.[0]?.customId).toBe("dndhub:wizNext:zh-TW.playByPost.5.split");
    expect(contentOf(loot)).toContain("由英雄平分");
  });

  it("lists the adventures for the game's language, and creates the game from the one chosen", async () => {
    const catalog = [
      { id: "moonlit-ruins", version: "1", languages: ["en" as const, "zh-TW" as const], titles: { en: "Moonlit Ruins", "zh-TW": "月光遺跡" } },
      { id: "gabc123-harbor", version: "2", languages: ["en" as const], titles: { en: "Harbor Heist" } },
      { id: "gabc123-farm", version: "1", languages: ["en" as const, "zh-TW" as const], titles: { en: "Farm Fright", "zh-TW": "農場驚魂" } },
    ];
    const t = harness({ catalog });
    await withSettings(t);
    const start = wizardState(defaultWizardChoices);
    const opened = await t.click(hubCustomId("wizAdventure", start), { userId: "u-a", admin: true });
    const menu = (payload: unknown): { custom_id: string; options: { label: string; value: string; description: string }[] } =>
      (payload as { components: { toJSON(): { components: unknown[] } }[] }).components[0]?.toJSON().components[0] as never;
    const list = menu(opened.at(-1)?.payload);
    expect(list.options.map((option) => option.label)).toEqual(["Moonlit Ruins", "Harbor Heist", "Farm Fright"]);
    expect(list.options[1]?.description).toBe("v2 · en");
    expect(list.options[0]?.value).toBe("default");

    // Choosing one brings back the wizard with it named and carried in the controls.
    const picked = await t.click(list.custom_id, { userId: "u-a", admin: true }, { values: ["gabc123-farm"] });
    expect(contentOf(picked)).toContain("Adventure: Farm Fright");
    expect(rowsOf(picked).at(-1)?.[0]?.customId).toBe("dndhub:wizNext:en.live.3.pooled.open.gabc123-farm");

    // In Chinese the English-only adventure is not offered. A selected English-only adventure cannot switch to Chinese.
    const chinese = await t.click(hubCustomId("wizAdventure", "zh-TW.live.3.pooled"), { userId: "u-a", admin: true });
    expect(menu(chinese.at(-1)?.payload).options.map((option) => option.label)).toEqual(["月光遺跡", "農場驚魂"]);
    const harbor = await t.click(hubCustomId("wizLanguage", "en.live.3.pooled.open.gabc123-harbor"), { userId: "u-a", admin: true }, { values: ["zh-TW"] });
    expect(rowsOf(harbor).at(-1)?.[0]?.customId).toBe("dndhub:wizNext:en.live.3.pooled.open.gabc123-harbor");
    expect(contentOf(harbor)).toContain("Adventure: Harbor Heist");
    const kept = await t.click(hubCustomId("wizLanguage", "en.live.3.pooled.open.gabc123-farm"), { userId: "u-a", admin: true }, { values: ["zh-TW"] });
    expect(rowsOf(kept).at(-1)?.[0]?.customId).toBe("dndhub:wizNext:zh-TW.live.3.pooled.open.gabc123-farm");
  });

  it("does not offer English for a Chinese-only selected adventure", async () => {
    const t = harness({ catalog: [
      { id: "moonlit-ruins", version: "1", languages: ["en", "zh-TW"], titles: { en: "Moonlit Ruins", "zh-TW": "月光遺跡" } },
      { id: "chinese-only", version: "1", languages: ["zh-TW"], titles: { "zh-TW": "中文冒險" } },
    ] });
    await withSettings(t);
    const picked = await t.click(hubCustomId("wizAdventurePick", "zh-TW.live.3.pooled"), { userId: "u-a", admin: true }, { values: ["chinese-only"] });
    const languageMenu = (picked.at(-1)?.payload as { components: { toJSON(): { components: { options?: { value: string }[] }[] } }[] }).components[0]?.toJSON().components[0];
    expect(languageMenu?.options?.map((option) => option.value)).toEqual(["zh-TW"]);
    const forged = await t.click(hubCustomId("wizLanguage", "zh-TW.live.3.pooled.open.chinese-only"), { userId: "u-a", admin: true }, { values: ["en"] });
    expect(contentOf(forged)).toContain("中文冒險");
    expect(rowsOf(forged).at(-1)?.[0]?.customId).toBe("dndhub:wizNext:zh-TW.live.3.pooled.open.chinese-only");
  });

  it("allows more players than the selected adventure has preset heroes", async () => {
    const t = harness({ catalog: [
      { id: "moonlit-ruins", version: "1", languages: ["en", "zh-TW"], titles: { en: "Moonlit Ruins" } },
      { id: "short-party", version: "1", languages: ["en"], titles: { en: "Short Party" } },
    ] });
    await withSettings(t);
    const picked = await t.click(hubCustomId("wizAdventurePick", "en.live.6.pooled"), { userId: "u-a", admin: true }, { values: ["short-party"] });
    const payload = picked.at(-1)?.payload as { components: { toJSON(): { components: { options?: { value: string }[]; custom_id?: string }[] } }[] };
    expect(payload.components[2]?.toJSON().components[0]?.options?.map((option) => option.value)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(rowsOf(picked).at(-1)?.[0]?.customId).toBe("dndhub:wizNext:en.live.6.pooled.open.short-party");
  });

  it("switches between open and players-only with a button, and remembers it in the controls", async () => {
    const t = harness();
    await withSettings(t);
    const start = wizardState(defaultWizardChoices);
    expect(contentOf(await t.click(hubCustomId("wizLanguage", start), { userId: "u-a", admin: true }, { values: ["en"] }))).toContain("Who can watch: everyone");
    const toggled = await t.click(hubCustomId("wizVisibility", start), { userId: "u-a", admin: true });
    expect(contentOf(toggled)).toContain("Who can watch: players only");
    const rows = rowsOf(toggled);
    expect(rows.at(-1)?.map((button) => button.customId)).toEqual(["dndhub:wizNext:en.live.3.pooled.players", "dndhub:wizVisibility:en.live.3.pooled.players"]);
    // And back again.
    const back = await t.click("dndhub:wizVisibility:en.live.3.pooled.players", { userId: "u-a", admin: true });
    expect(rowsOf(back).at(-1)?.[0]?.customId).toBe("dndhub:wizNext:en.live.3.pooled");
    // Not for players.
    expect(contentOf(await t.click(hubCustomId("wizVisibility", start), { userId: "u-x" }))).toBe("Only DnD Admins can create games.");
  });

  it("opens the name form from Next and creates the game from it with the chosen settings", async () => {
    const t = harness();
    await withSettings(t);
    const modal = await t.click("dndhub:wizNext:zh-TW.playByPost.4.split", { userId: "u-a", admin: true });
    expect(modal[0]?.kind).toBe("modal");
    expect(JSON.stringify((modal[0]?.payload as { toJSON(): unknown }).toJSON())).toContain("dndhub:wizName:zh-TW.playByPost.4.split");

    await t.submit("dndhub:wizName:zh-TW.playByPost.4.split", { userId: "u-a", admin: true }, "月光遺跡");
    expect(t.createCalls).toEqual([{ guildId, organizerId: "u-a", name: "月光遺跡", language: "zh-TW", pacing: "playByPost", players: 4, lootGold: "split", visibility: "open" }]);
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
    expect(rowsOf(organizer).flat().map((button) => button.label)).toEqual(["Pause", "Close round", "Retry the DM", "Redo the last picture", "Raise level", "Short rest", "Long rest", "Retry the fight", "Retell the last scene", "Picture the latest moment", "Picture the current scene", "Invite player", "Join requests (0)", "Repair cards", "Hazard", "Hurt", "End game"]);
    expect(rowsOf(await t.click(id, { userId: "u-a", admin: true }, { messageId: hubMessageId })).flat()).toHaveLength(17);
  });

  it("shows no picture buttons when the bot cannot paint, and says so if one is pressed anyway", async () => {
    const t = harness({ images: false });
    const { key, hubMessageId } = await activeGame(t);
    const organizer = await t.click(hubCustomId("manage", key.campaignId), { userId: "u-org" }, { messageId: hubMessageId });
    const labels = rowsOf(organizer).flat().map((button) => button.label);
    expect(labels).not.toContain("Redo the last picture");
    expect(labels).not.toContain("Picture the latest moment");
    expect(labels).not.toContain("Picture the current scene");
    const pressed = await t.click(hubCustomId("do", key.campaignId, "illustrate"), { userId: "u-org" }, { messageId: hubMessageId });
    expect(contentOf(pressed)).toContain("no picture painter");
  });

  it("asks for the current scene, retries a failed picture, and shows how the pictures are doing", async () => {
    const t = harness();
    const { key, hubMessageId } = await activeGame(t);
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadRecord(key);
      if (stored === undefined) throw new Error("record");
      await tx.saveRecord({ ...stored.record, images: { "scene:ruined-chapel": "failed", "moment:round-2": "done" }, lastPicture: "moment:round-2" }, stored.revision);
    });
    const screen = await t.click(hubCustomId("manage", key.campaignId), { userId: "u-org" }, { messageId: hubMessageId });
    expect(contentOf(screen)).toContain("Pictures: 1 posted, 1 failed, 0 skipped.");
    const labels = rowsOf(screen).flat().map((button) => button.label);
    expect(labels).toContain("Retry failed picture (1)");
    expect(labels).toContain("Redo picture: round 2");

    await t.click(hubCustomId("do", key.campaignId, "retryPicture"), { userId: "u-org" }, { messageId: hubMessageId });
    await t.click(hubCustomId("do", key.campaignId, "illustrateScene"), { userId: "u-org" }, { messageId: hubMessageId });
    const asked = (await t.r.store.transaction((tx) => tx.pendingOutbox("redoImage"))).map((item) => (item.request.kind === "redoImage" ? item.request.subject : ""));
    expect(asked).toContain("scene:ruined-chapel");
    expect(asked).toHaveLength(2);
  });

  it("puts an icon on the manage buttons that have one, once the icons are uploaded", async () => {
    const t = harness({ icons: true });
    const { key, hubMessageId } = await activeGame(t);
    const sent = await t.click(hubCustomId("manage", key.campaignId), { userId: "u-org" }, { messageId: hubMessageId });
    const last = [...sent].reverse().find((entry) => entry.kind === "edit" || entry.kind === "update" || entry.kind === "reply");
    const rows = (last?.payload as { components: { toJSON(): { components: { label?: string; emoji?: { name: string } }[] } }[] }).components;
    const buttons = rows.flatMap((row) => row.toJSON().components);
    expect(buttons.find((button) => button.label === "Pause")?.emoji?.name).toBe("dnd_pause");
    expect(buttons.find((button) => button.label === "Short rest")?.emoji?.name).toBe("dnd_rest");
    expect(buttons.find((button) => button.label === "Close round")?.emoji).toBeUndefined();
  });

  it("refuses Retry the fight when there is no lost fight", async () => {
    const t = harness();
    const { key } = await activeGame(t);
    expect(contentOf(await t.click(hubCustomId("do", key.campaignId, "retryFight"), { userId: "u-org" }))).toContain("There is no lost fight to play again");
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

describe("the hub launcher", () => {
  const anyone = { userId: "u-x" };
  const admin = { userId: "u-a", admin: true };
  const upload = { url: "https://cdn.discordapp.com/attachments/1/2/file.json", size: 500 };
  const modalOf = (sent: readonly Sent[]): { custom_id: string; title: string; components: { label: string; component: { custom_id: string } }[] } | undefined =>
    (sent.find((entry) => entry.kind === "modal")?.payload as { toJSON(): never } | undefined)?.toJSON();

  it("explains itself, in the reader's own language", async () => {
    const t = harness();
    expect(contentOf(await t.click("dndhub:help", anyone))).toContain("How D&D works here");
    const zh = fakeInteraction({ ...anyone, customId: "dndhub:help", kind: "button", locale: "zh-TW" });
    await new CampaignHubComponentHandler({ lobby: t.r.service, play: undefined as never, setup: undefined as never, cards: t.cards, creator: undefined as never, authority: undefined as never }).execute({ interaction: zh.interaction, logger: quiet as never });
    expect(contentOf(zh.sent)).toContain("D&D 使用說明");
  });

  it("opens My Characters and the builder for anyone, as the same private screens the slash command opens", async () => {
    const t = harness();
    const home = await t.click("dndhub:characters", { userId: "u-x" });
    expect(contentOf(home)).toBe("home of u-x in en");
    expect(home[0]).toMatchObject({ kind: "defer" });
    expect(contentOf(await t.click("dndhub:newCharacter", anyone))).toBe("builder in en");
  });

  it("opens the builder in the server language even when the player uses an English Discord client", async () => {
    const t = harness({ guildLanguage: "zh-TW" });
    const opened = await t.click("dndhub:newCharacter", { userId: "u-x" });
    expect(contentOf(opened)).toBe("builder in zh-TW");
    await withSettings(t);
    const wizard = await t.click("dndhub:create", { userId: "u-a", admin: true });
    expect(contentOf(wizard)).toContain("語言：繁體中文");
  });

  it("says a button is unavailable when the bot was started without that part", async () => {
    const t = harness({ launcher: false });
    await withSettings(t);
    expect(contentOf(await t.click("dndhub:characters", anyone))).toBe("That is not available on this bot right now.");
    expect(contentOf(await t.click("dndhub:importOpen", anyone))).toBe("That is not available on this bot right now.");
    expect(contentOf(await t.click("dndhub:uploadOpen", admin))).toBe("That is not available on this bot right now.");
  });

  it("opens the import form for anyone and reads the file they send, exactly as /dnd import-character does", async () => {
    const t = harness();
    const modal = modalOf(await t.click("dndhub:importOpen", anyone));
    expect(modal?.custom_id).toBe("dndhub:importSubmit");
    expect(modal?.components.map((row) => row.label)).toEqual(["Character file"]);
    expect(modal?.components[0]?.component.custom_id).toBe("file");

    const done = await t.form("dndhub:importSubmit", anyone, { uploads: { file: [upload] } });
    expect(contentOf(done)).toBe("imported it");
    expect(t.library.imports).toEqual([{ userId: "u-x", language: "en", file: upload }]);
    // No file in the form is passed on as none, for the shared reader to explain.
    await t.form("dndhub:importSubmit", anyone, {});
    expect(t.library.imports[1]?.file).toBeNull();
  });

  it("keeps the adventure forms for DnD Admins, checking again when the form is sent", async () => {
    const t = harness();
    await withSettings(t);
    expect(contentOf(await t.click("dndhub:uploadOpen", anyone))).toBe("Only bot administrators can do that.");
    expect(contentOf(await t.click("dndhub:authorOpen", anyone))).toBe("Only bot administrators can do that.");
    expect(contentOf(await t.form("dndhub:uploadSubmit", anyone, { uploads: { file: [upload] } }))).toBe("Only bot administrators can do that.");
    expect(contentOf(await t.form("dndhub:authorSubmit", anyone, { fields: { idea: "a chapel" } }))).toBe("Only bot administrators can do that.");
    expect(t.intake.uploads).toEqual([]);
    expect(t.intake.authors).toEqual([]);
  });

  it("uploads an adventure from the form for a DnD Admin", async () => {
    const t = harness();
    await withSettings(t);
    const modal = modalOf(await t.click("dndhub:uploadOpen", admin));
    expect(modal?.custom_id).toBe("dndhub:uploadSubmit");
    expect(modal?.title).toBe("Upload an adventure");
    expect(contentOf(await t.form("dndhub:uploadSubmit", admin, { uploads: { file: [upload] }, selects: { language: ["zh-TW"] } }))).toBe("under review");
    expect(t.intake.uploads).toEqual([{ guildId, file: upload }]);
  });

  it("has the Author write from an idea, a language and optional notes", async () => {
    const t = harness();
    await withSettings(t);
    const modal = modalOf(await t.click("dndhub:authorOpen", admin));
    expect(modal?.components.map((row) => row.component.custom_id)).toEqual(["idea", "language", "file"]);
    expect(contentOf(await t.form("dndhub:authorSubmit", admin, { fields: { idea: "A haunted chapel" }, selects: { language: ["zh-TW"] }, uploads: { file: [upload] } }))).toBe("written");
    expect(t.intake.authors).toEqual([{ guildId, input: { idea: "A haunted chapel", gameLanguage: "zh-TW", notes: upload } }]);
    // Without notes, the language falls back to English.
    await t.form("dndhub:authorSubmit", admin, { fields: { idea: "x" } });
    expect(t.intake.authors[1]?.input).toEqual({ idea: "x", gameLanguage: "en", notes: null });
  });

  it("says so when there is no AI author", async () => {
    const t = harness({ canAuthor: false });
    await withSettings(t);
    expect(contentOf(await t.click("dndhub:authorOpen", admin))).toBe("No AI author is set up on this bot.");
  });
});

describe("Raise level in Manage", () => {
  it("opens a form for the organizer only, and raises the party from it", async () => {
    const t = harness();
    const { key } = await activeGame(t);
    const id = hubCustomId("levelOpen", key.campaignId);
    expect(contentOf(await t.click(id, { userId: "u-x" }))).toBe("Only DnD Admins and the game's organizer can manage a game.");
    const opened = await t.click(id, { userId: "u-org" });
    const modal = (opened.find((entry) => entry.kind === "modal")?.payload as { toJSON(): { custom_id: string; components: { label: string }[] } }).toJSON();
    expect(modal.custom_id).toBe(hubCustomId("levelSubmit", key.campaignId));
    expect(modal.components[0]?.label).toBe("Level (2 to 20)");

    const raised = await t.form(hubCustomId("levelSubmit", key.campaignId), { userId: "u-org" }, { fields: { level: "3" } });
    expect(contentOf(raised)).toContain("The party is now level 3");
    const state = (await t.r.store.transaction((tx) => tx.loadCampaign(key)))?.state;
    expect(Object.values(state?.characters ?? {}).every((sheet) => sheet.level === 3)).toBe(true);
    // Again to the same level, an odd number, and a stranger sending the form.
    expect(contentOf(await t.form(hubCustomId("levelSubmit", key.campaignId), { userId: "u-org" }, { fields: { level: "3" } }))).toContain("already at that level or higher");
    expect(contentOf(await t.form(hubCustomId("levelSubmit", key.campaignId), { userId: "u-org" }, { fields: { level: "many" } }))).toContain("Pick a level from 2 to 20");
    expect(contentOf(await t.form(hubCustomId("levelSubmit", key.campaignId), { userId: "u-x" }, { fields: { level: "4" } }))).toBe("Only DnD Admins and the game's organizer can manage a game.");
  });

  it("lets a DnD Admin raise a game they do not organize", async () => {
    const t = harness();
    const { key } = await activeGame(t);
    expect(contentOf(await t.form(hubCustomId("levelSubmit", key.campaignId), { userId: "u-a", admin: true }, { fields: { level: "2" } }))).toContain("The party is now level 2");
  });
});

describe("Hazard in Manage", () => {
  it("opens a form naming who faces it, the save and the DC, for the organizer or a DnD Admin only", async () => {
    const t = harness();
    const { key } = await activeGame(t);
    const id = hubCustomId("hazardOpen", key.campaignId);
    expect(contentOf(await t.click(id, { userId: "u-x" }))).toBe("Only DnD Admins and the game's organizer can manage a game.");
    const opened = await t.click(id, { userId: "u-org" });
    const modal = (opened.find((entry) => entry.kind === "modal")?.payload as { toJSON(): { custom_id: string; components: { label: string; component: { custom_id: string; options?: { value: string }[] } }[] } }).toJSON();
    expect(modal.custom_id).toBe(hubCustomId("hazardSubmit", key.campaignId));
    expect(modal.components.map((row) => row.component.custom_id)).toEqual(["who", "ability", "dc"]);
    // The whole party first, then each hero still in play.
    expect(modal.components[0]?.component.options?.map((option) => option.value)[0]).toBe("party");
    expect(modal.components[0]?.component.options?.length).toBeGreaterThan(1);
    expect(modal.components[1]?.component.options?.map((option) => option.value)).toEqual(["str", "dex", "con", "int", "wis", "cha"]);
  });

  it("sets a real saving throw for the party and refuses a stranger, a bad DC or a bad save", async () => {
    const t = harness();
    const { key } = await activeGame(t);
    const id = hubCustomId("hazardSubmit", key.campaignId);
    const set = await t.form(id, { userId: "u-org" }, { selects: { who: ["party"], ability: ["con"] }, fields: { dc: "13" } });
    expect(contentOf(set)).toContain("The hazard is set.");
    const state = (await t.r.store.transaction((tx) => tx.loadCampaign(key)))?.state;
    expect(Object.values(state?.hazardPending ?? {}).map((hazard) => [hazard.ability, hazard.dc])).toEqual([["con", 13]]);
    expect(contentOf(await t.form(id, { userId: "u-org" }, { selects: { who: ["party"], ability: ["con"] }, fields: { dc: "40" } }))).toContain("Pick an ability and a DC from 5 to 30.");
    expect(contentOf(await t.form(id, { userId: "u-org" }, { selects: { who: ["party"], ability: ["nope"] }, fields: { dc: "13" } }))).toContain("Pick an ability and a DC from 5 to 30.");
    expect(contentOf(await t.form(id, { userId: "u-x" }, { selects: { who: ["party"], ability: ["con"] }, fields: { dc: "13" } }))).toBe("Only DnD Admins and the game's organizer can manage a game.");
  });
});
