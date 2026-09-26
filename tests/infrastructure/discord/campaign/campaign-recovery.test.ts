import { describe, expect, it } from "vitest";

import { CampaignIssues } from "../../../../src/application/campaign/campaign-issues.js";
import type { CampaignKey } from "../../../../src/application/campaign/ports/campaign-store.js";
import { enSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { starterAdventureId } from "../../../../src/infrastructure/campaign/starter-adventures.js";
import { CampaignCardService } from "../../../../src/infrastructure/discord/campaign/campaign-card-service.js";
import { CampaignRecovery } from "../../../../src/infrastructure/discord/campaign/campaign-recovery.js";
import { CampaignSetupService } from "../../../../src/infrastructure/discord/campaign/campaign-setup-service.js";
import { organizerNotice } from "../../../../src/infrastructure/discord/campaign/issue-notifier.js";
import { guildId, quiet, rig, type Rig } from "../../../application/campaign/campaign-rig.js";
import { FakeMessages } from "./fake-messages.js";
import { FakeResources } from "./fake-resources.js";

interface Table {
  r: Rig;
  messages: FakeMessages;
  resources: FakeResources;
  setup: CampaignSetupService;
  cards: CampaignCardService;
  issues: CampaignIssues;
  recovery: CampaignRecovery;
  clock: { now: number };
  key: CampaignKey;
}

async function table(language: "en" | "zh-TW" = "en"): Promise<Table> {
  const r = rig();
  const messages = new FakeMessages();
  const resources = new FakeResources();
  const clock = { now: 1_000_000 };
  const issues = new CampaignIssues({ unitOfWork: r.store, clock: r.clock, notify: organizerNotice(messages) });
  const cards = new CampaignCardService({
    unitOfWork: r.store,
    rulesets: r.rulesets,
    adventures: r.adventures,
    messages,
    glossaries: { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary },
    logger: quiet,
    issues,
    now: (): number => clock.now,
  });
  const setup = new CampaignSetupService({ unitOfWork: r.store, resources, cards, logger: quiet, issues });
  const recovery = new CampaignRecovery({ unitOfWork: r.store, lobby: r.service, setup, cards, issues, logger: quiet, now: (): number => clock.now });
  await setup.setupGuild(guildId, null);
  const created = await r.service.create({ guildId, organizerId: "u-org", name: "Moonlit Ruins", language, adventureId: starterAdventureId, pacing: { preset: "live" } });
  if (created.kind !== "ok") throw new Error("create");
  const { key } = created.value;
  expect((await setup.provision(key)).kind).toBe("ok");
  return { r, messages, resources, setup, cards, issues, recovery, clock, key };
}

const gameRoles = (t: Table): string[] => t.resources.roleNames.filter((name) => name.startsWith("🎲"));

const recordOf = async (t: Table): Promise<NonNullable<Awaited<ReturnType<Table["r"]["service"]["get"]>>>["record"]> => {
  const stored = await t.r.service.get(t.key);
  if (stored === undefined) throw new Error("record");
  return stored.record;
};

// The Party card is gone (its message was deleted and the reference dropped).
async function loseLobbyCard(t: Table): Promise<void> {
  await t.r.store.transaction(async (tx) => {
    const stored = await tx.loadRecord(t.key);
    if (stored === undefined) throw new Error("record");
    const { lobby: _lost, ...cards } = stored.record.cards;
    await tx.saveRecord({ ...stored.record, cards }, stored.revision);
  });
}

describe("cards that cannot be drawn", () => {
  it("become one organizer issue and one notice, are not retried at once, and clear when they draw again", async () => {
    const t = await table();
    const partyId = (await recordOf(t)).channels.partyChannelId ?? "";
    // The Party card is gone from Discord and every send is refused.
    await loseLobbyCard(t);
    t.messages.failSends = 100;
    await t.cards.sync(t.key);
    const raised = (await recordOf(t)).issues ?? [];
    expect(raised).toMatchObject([{ code: "permissions", detail: "lobby", notified: true }]);
    expect(t.messages.posts.filter((post) => post.content.includes("missing a permission"))).toHaveLength(1);
    const attempts = t.messages.failSends;
    await t.cards.sync(t.key);
    // The failing card was left alone the second time.
    expect(t.messages.failSends).toBe(attempts);
    t.messages.failSends = 0;
    // Repair ignores the wait, draws the card, and the issue is gone.
    t.clock.now += 10;
    const repaired = await t.setup.repair(t.key);
    expect(repaired).toEqual({ kind: "ok", requeued: 0 });
    expect((await recordOf(t)).issues ?? []).toEqual([]);
    expect((await recordOf(t)).cards.lobby?.channelId).toBe(partyId);
  });

  it("tell the organizer where they can still be reached, naming them", async () => {
    const t = await table();
    await loseLobbyCard(t);
    // The next send (the Party card) is refused; the notice goes out on the Adventure channel's post.
    t.messages.failSends = 1;
    await t.cards.sync(t.key);
    const notice = t.messages.posts.find((post) => post.content.includes("missing a permission"));
    expect(notice?.mentions).toEqual(["u-org"]);
    expect(notice?.content).toContain("<@u-org>");
    expect((await recordOf(t)).issues).toMatchObject([{ code: "permissions", notified: true }]);
  });

  it("show in Traditional Chinese for a Chinese game", async () => {
    const t = await table("zh-TW");
    await loseLobbyCard(t);
    t.messages.failSends = 1;
    await t.cards.sync(t.key);
    expect(t.messages.posts.some((post) => post.content.includes("缺少維持這個團務面板所需的權限"))).toBe(true);
  });

  it("raise nothing for a finished game", async () => {
    const t = await table();
    await loseLobbyCard(t);
    await t.r.service.cancel(t.key, "u-org");
    t.messages.failSends = 100;
    await t.cards.sync(t.key);
    expect((await recordOf(t)).issues ?? []).toEqual([]);
  });
});

describe("Repair", () => {
  it("sends the messages that were given up on, and clears that issue", async () => {
    const t = await table();
    await t.r.store.transaction(async (tx) => {
      await tx.enqueue(t.key, "d1", { kind: "deliver", delivery: { kind: "quietRound", roundNumber: 1 } }, 1);
      await tx.failOutboxAttempt("d1", "down", 1);
    });
    await t.issues.raise(t.key, "deliveryFailed", "quietRound");
    expect(await t.r.store.transaction((tx) => tx.pendingOutbox("deliver"))).toEqual([]);
    expect(await t.setup.repair(t.key)).toEqual({ kind: "ok", requeued: 1 });
    expect(await t.r.store.transaction((tx) => tx.pendingOutbox("deliver"))).toHaveLength(1);
    expect((await recordOf(t)).issues ?? []).toEqual([]);
  });

  it("reports a missing permission as an issue and does nothing else", async () => {
    const t = await table();
    t.resources.missing = ["ManageThreads"];
    expect(await t.setup.repair(t.key)).toEqual({ kind: "missingPermissions", missing: ["ManageThreads"] });
    expect((await recordOf(t)).issues).toMatchObject([{ code: "permissions", detail: "ManageThreads" }]);
  });

  it("leaves a finished or unknown game alone", async () => {
    const t = await table();
    await t.r.service.cancel(t.key, "u-org");
    expect(await t.setup.repair(t.key)).toEqual({ kind: "archived" });
    expect(await t.setup.repair({ guildId, campaignId: "nope" })).toEqual({ kind: "notFound" });
  });
});

describe("a players-only game", () => {
  const started = async (): Promise<Table> => {
    const t = await table();
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadRecord(t.key);
      if (stored === undefined) throw new Error("record");
      await tx.saveRecord({ ...stored.record, visibility: "membersOnly" }, stored.revision);
    });
    await t.r.service.join(t.key, "u-org");
    await t.r.service.chooseHero(t.key, "u-org", "c-mira");
    await t.r.service.join(t.key, "u-two");
    await t.r.service.chooseHero(t.key, "u-two", "c-borin");
    return t;
  };

  it("stays open while people are joining, and hides both channels from everyone but the role once it starts", async () => {
    const t = await started();
    // The lobby is open: nobody has to be invited to press Join.
    expect(await t.setup.applyVisibility(t.key)).toEqual({ kind: "open" });
    expect(t.resources.restricted).toEqual([]);

    await t.r.service.start(t.key, "u-org");
    const result = await t.setup.applyVisibility(t.key);
    if (result.kind !== "applied") throw new Error("visibility");
    const record = await recordOf(t);
    expect(record.channels.roleId).toBe(result.roleId);
    expect(gameRoles(t)).toEqual(["🎲 Moonlit Ruins"]);
    expect(t.resources.restricted).toEqual([
      { channelId: record.channels.partyChannelId, roleId: result.roleId, allowThreadMessages: true },
      { channelId: record.channels.adventureChannelId, roleId: result.roleId, allowThreadMessages: false },
    ]);
    // The organizer and every player at the table hold the role.
    expect(new Set(t.resources.grants.map((grant) => grant.userId))).toEqual(new Set(["u-org", "u-two"]));
  });

  it("makes the role once, gives it back to a player who lost it on Repair, and keeps it when the game ends", async () => {
    const t = await started();
    await t.r.service.start(t.key, "u-org");
    await t.setup.applyVisibility(t.key);
    t.resources.grants.length = 0;
    expect(await t.setup.repair(t.key)).toEqual({ kind: "ok", requeued: 0 });
    expect(gameRoles(t)).toHaveLength(1);
    expect(t.resources.grants).toHaveLength(2);
    await t.r.service.end(t.key);
    expect((await recordOf(t)).channels.roleId).not.toBeNull();
    expect(await t.setup.applyVisibility(t.key)).toMatchObject({ kind: "applied" });
    expect(gameRoles(t)).toHaveLength(1);
  });

  it("makes a role that was deleted again", async () => {
    const t = await started();
    await t.r.service.start(t.key, "u-org");
    await t.setup.applyVisibility(t.key);
    t.resources.roles.clear();
    await t.setup.applyVisibility(t.key);
    expect(gameRoles(t)).toHaveLength(2);
  });

  it("reports a missing permission as an organizer issue instead of leaving the game half hidden", async () => {
    const t = await started();
    await t.r.service.start(t.key, "u-org");
    t.resources.failGrants = true;
    expect(await t.setup.applyVisibility(t.key)).toEqual({ kind: "failed" });
    expect((await recordOf(t)).issues).toMatchObject([{ code: "permissions", detail: "role" }]);
  });

  it("makes a channel deleted later already hidden from everyone but the role", async () => {
    const t = await started();
    await t.r.service.start(t.key, "u-org");
    const applied = await t.setup.applyVisibility(t.key);
    if (applied.kind !== "applied") throw new Error("visibility");
    const gone = (await recordOf(t)).channels.adventureChannelId ?? "";
    t.resources.channels.splice(t.resources.channels.findIndex((channel) => channel.id === gone), 1);
    await t.recovery.channelDeleted(guildId, gone);
    const made = t.resources.channels.find((channel) => channel.id === (t.resources.channels.at(-1)?.id ?? ""));
    expect(made?.options.viewerRoleId).toBe(applied.roleId);
  });

  it("does nothing for an open game", async () => {
    const t = await table();
    await t.r.service.join(t.key, "u-org");
    await t.r.service.chooseHero(t.key, "u-org", "c-mira");
    await t.r.service.start(t.key, "u-org");
    expect(await t.setup.applyVisibility(t.key)).toEqual({ kind: "open" });
    expect(gameRoles(t)).toEqual([]);
  });
});

describe("a place taken away", () => {
  it("makes a deleted game channel again and draws its cards there", async () => {
    const t = await table();
    const before = await recordOf(t);
    const gone = before.channels.adventureChannelId ?? "";
    t.resources.channels.splice(t.resources.channels.findIndex((channel) => channel.id === gone), 1);
    await t.recovery.channelDeleted(guildId, gone);
    const after = await recordOf(t);
    expect(after.channels.adventureChannelId).not.toBe(gone);
    expect(t.resources.channels.some((channel) => channel.id === after.channels.adventureChannelId)).toBe(true);
  });

  it("makes a deleted Table Talk thread again", async () => {
    const t = await table();
    const before = (await recordOf(t)).channels.discussionThreadId ?? "";
    t.resources.threads.splice(0, 1);
    await t.recovery.channelDeleted(guildId, before);
    const after = (await recordOf(t)).channels.discussionThreadId;
    expect(after).not.toBe(before);
    expect(t.resources.threads.map((thread) => thread.id)).toEqual([after]);
  });

  it("does not bring back a finished game's channel", async () => {
    const t = await table();
    const gone = (await recordOf(t)).channels.adventureChannelId ?? "";
    await t.r.service.cancel(t.key, "u-org");
    t.resources.channels.splice(t.resources.channels.findIndex((channel) => channel.id === gone), 1);
    const count = t.resources.channels.length;
    await t.recovery.channelDeleted(guildId, gone);
    expect(t.resources.channels).toHaveLength(count);
  });

  it("stops making a channel again when it keeps being deleted, and tells the organizer instead", async () => {
    const t = await table();
    for (let round = 0; round < 3; round += 1) {
      const id = (await recordOf(t)).channels.adventureChannelId ?? "";
      t.resources.channels.splice(t.resources.channels.findIndex((channel) => channel.id === id), 1);
      await t.recovery.channelDeleted(guildId, id);
    }
    const count = t.resources.channels.length;
    const id = (await recordOf(t)).channels.adventureChannelId ?? "";
    t.resources.channels.splice(t.resources.channels.findIndex((channel) => channel.id === id), 1);
    await t.recovery.channelDeleted(guildId, id);
    expect(t.resources.channels).toHaveLength(count - 1);
    expect((await recordOf(t)).issues).toMatchObject([{ code: "channelMissing", detail: "recreated too often" }]);
    // An hour later it is allowed again, and Repair always makes it.
    t.clock.now += 61 * 60 * 1000;
    await t.recovery.channelDeleted(guildId, id);
    expect(t.resources.channels).toHaveLength(count);
  });

  it("reports missing permissions instead of failing quietly", async () => {
    const t = await table();
    const gone = (await recordOf(t)).channels.adventureChannelId ?? "";
    t.resources.channels.splice(t.resources.channels.findIndex((channel) => channel.id === gone), 1);
    t.resources.missing = ["ManageChannels"];
    await t.recovery.channelDeleted(guildId, gone);
    expect((await recordOf(t)).issues).toMatchObject([{ code: "permissions", detail: "ManageChannels" }]);
  });
});
