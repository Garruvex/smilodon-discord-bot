import { describe, expect, it } from "vitest";

import { enSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { starterAdventureId } from "../../../../src/infrastructure/campaign/starter-adventures.js";
import { CampaignCardService } from "../../../../src/infrastructure/discord/campaign/campaign-card-service.js";
import type { CampaignResourceGateway, TextChannelOptions } from "../../../../src/infrastructure/discord/campaign/campaign-resource-gateway.js";
import { CampaignSetupService } from "../../../../src/infrastructure/discord/campaign/campaign-setup-service.js";
import { guildId, quiet, rig, type Rig } from "../../../application/campaign/campaign-rig.js";
import { flatten } from "./card-helpers.js";
import { FakeMessages } from "./fake-messages.js";

interface FakeChannel {
  id: string;
  options: TextChannelOptions;
}

class FakeResources implements CampaignResourceGateway {
  public readonly categories = new Set<string>();
  public readonly channels: FakeChannel[] = [];
  public readonly threads: { id: string; channelId: string; name: string }[] = [];
  public missing: string[] = [];
  public failCreates = 0;
  public failThreads = 0;
  private next = 0;

  public createCategory(): Promise<string> {
    this.next += 1;
    const id = `cat${this.next}`;
    this.categories.add(id);
    return Promise.resolve(id);
  }

  public categoryExists(_guildId: string, categoryId: string): Promise<boolean> {
    return Promise.resolve(this.categories.has(categoryId));
  }

  public createTextChannel(_guildId: string, options: TextChannelOptions): Promise<string> {
    if (this.failCreates > 0) {
      this.failCreates -= 1;
      // The create may have gone through even though the bot never heard back.
      this.next += 1;
      this.channels.push({ id: `ch${this.next}`, options });
      return Promise.reject(new Error("timeout"));
    }
    this.next += 1;
    const id = `ch${this.next}`;
    this.channels.push({ id, options });
    return Promise.resolve(id);
  }

  public channelExists(_guildId: string, channelId: string): Promise<boolean> {
    return Promise.resolve(this.channels.some((channel) => channel.id === channelId));
  }

  public findTextChannelByMarker(_guildId: string, _categoryId: string | null, marker: string): Promise<string | null> {
    return Promise.resolve(this.channels.find((channel) => channel.options.topic.includes(marker))?.id ?? null);
  }

  public channelNames(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(this.channels.map((channel) => channel.options.name)));
  }

  public createDiscussionThread(channelId: string, name: string): Promise<string> {
    if (this.failThreads > 0) {
      this.failThreads -= 1;
      return Promise.reject(new Error("no thread permission"));
    }
    this.next += 1;
    const id = `th${this.next}`;
    this.threads.push({ id, channelId, name });
    return Promise.resolve(id);
  }

  public findThreadByName(channelId: string, name: string): Promise<string | null> {
    return Promise.resolve(this.threads.find((thread) => thread.channelId === channelId && thread.name === name)?.id ?? null);
  }

  public threadExists(threadId: string): Promise<boolean> {
    return Promise.resolve(this.threads.some((thread) => thread.id === threadId));
  }

  public missingPermissions(): Promise<readonly string[]> {
    return Promise.resolve(this.missing);
  }
}

function setup(r: Rig): { resources: FakeResources; messages: FakeMessages; service: CampaignSetupService } {
  const resources = new FakeResources();
  const messages = new FakeMessages();
  const cards = new CampaignCardService({
    unitOfWork: r.store,
    rulesets: r.rulesets,
    adventures: r.adventures,
    messages,
    glossaries: { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary },
    logger: quiet,
  });
  return { resources, messages, service: new CampaignSetupService({ unitOfWork: r.store, resources, cards, logger: quiet }) };
}

async function newGame(r: Rig, name = "Moonlit Ruins", language: "en" | "zh-TW" = "en"): Promise<{ guildId: string; campaignId: string }> {
  const created = await r.service.create({ guildId, organizerId: "u-org", name, language, adventureId: starterAdventureId, pacing: { preset: "live" } });
  if (created.kind !== "ok") throw new Error("create");
  return created.value.key;
}

describe("server setup", () => {
  it("creates the D&D category and a read-only hub channel, and lists games there", async () => {
    const r = rig();
    const { service, resources, messages } = setup(r);
    const result = await service.setupGuild(guildId, null);
    if (result.kind !== "ok") throw new Error("setup");
    expect(resources.categories.size).toBe(1);
    expect(resources.channels).toHaveLength(1);
    expect(resources.channels[0]?.options).toMatchObject({ name: "dnd-games", playersReadOnly: true });
    expect(result.settings).toMatchObject({ categoryId: "cat1", hubChannelId: "ch2" });
    expect(flatten(messages.live("ch2")[0]!.payload).text).toContain("No games yet");
  });

  it("uses the channel the organizer ran it in as the hub, and keeps the category on a repeat", async () => {
    const r = rig();
    const { service, resources } = setup(r);
    resources.channels.push({ id: "mine", options: { name: "general", topic: "", parentId: null, playersReadOnly: false, allowThreadMessages: false } });
    const first = await service.setupGuild(guildId, "mine");
    const again = await service.setupGuild(guildId, "mine");
    expect(first).toEqual(again);
    expect(resources.categories.size).toBe(1);
    expect(again.kind === "ok" && again.settings.hubChannelId).toBe("mine");
  });

  it("creates nothing when the bot lacks permissions, and says which", async () => {
    const r = rig();
    const { service, resources } = setup(r);
    resources.missing = ["ManageChannels"];
    expect(await service.setupGuild(guildId, null)).toEqual({ kind: "missingPermissions", missing: ["ManageChannels"] });
    expect(resources.categories.size).toBe(0);
    expect(resources.channels).toHaveLength(0);
  });
});

describe("creating a game's channels", () => {
  it("makes <name> and <name>-stats plus a Table Talk thread, read-only for players", async () => {
    const r = rig();
    const { service, resources, messages } = setup(r);
    await service.setupGuild(guildId, null);
    const key = await newGame(r);
    const result = await service.provision(key);
    if (result.kind !== "ok") throw new Error(`provision: ${result.kind}`);

    const names = resources.channels.map((channel) => channel.options.name);
    expect(names).toContain("moonlit-ruins");
    expect(names).toContain("moonlit-ruins-stats");
    const party = resources.channels.find((channel) => channel.options.name === "moonlit-ruins-stats");
    const adventure = resources.channels.find((channel) => channel.options.name === "moonlit-ruins");
    expect(party?.options).toMatchObject({ playersReadOnly: true, allowThreadMessages: true, parentId: "cat1" });
    expect(adventure?.options).toMatchObject({ playersReadOnly: true, allowThreadMessages: false });
    expect(result.record.channels).toMatchObject({ partyChannelId: party?.id, adventureChannelId: adventure?.id });
    expect(result.record.channels.discussionThreadId).toBe(resources.threads[0]?.id);
    expect(resources.threads[0]?.name).toBe("Moonlit Ruins — Table Talk");
    expect(result.record.pendingResources.map((resource) => [resource.kind, resource.resourceId !== null])).toEqual([["partyChannel", true], ["adventureChannel", true], ["discussionThread", true]]);
    // The lobby card is on the Party channel and the hub lists the game.
    expect(flatten(messages.live(party?.id ?? "")[0]!.payload).text).toContain("Moonlit Ruins — Lobby");
  });

  it("names a second game with the same name apart from the first", async () => {
    const r = rig();
    const { service, resources } = setup(r);
    await service.setupGuild(guildId, null);
    const first = await newGame(r);
    await service.provision(first);
    // A finished game frees the campaign name; its channels keep theirs.
    await r.service.cancel(first, "u-org");
    const second = await newGame(r);
    await service.provision(second);
    const names = resources.channels.map((channel) => channel.options.name);
    expect(names).toContain("moonlit-ruins-2");
    expect(names).toContain("moonlit-ruins-2-stats");
  });

  it("asks for /dnd setup first", async () => {
    const r = rig();
    const { service } = setup(r);
    expect(await service.provision(await newGame(r))).toEqual({ kind: "notSetup" });
    expect(await service.provision({ guildId, campaignId: "missing" })).toEqual({ kind: "notFound" });
  });

  it("creates nothing without permissions", async () => {
    const r = rig();
    const { service, resources } = setup(r);
    await service.setupGuild(guildId, null);
    const key = await newGame(r);
    const before = resources.channels.length;
    resources.missing = ["CreatePublicThreads"];
    expect(await service.provision(key)).toEqual({ kind: "missingPermissions", missing: ["CreatePublicThreads"] });
    expect(resources.channels).toHaveLength(before);
  });

  it("resumes after a failure without duplicating what was already made", async () => {
    const r = rig();
    const { service, resources } = setup(r);
    await service.setupGuild(guildId, null);
    const key = await newGame(r);
    // The Party channel is created on Discord but the answer is lost.
    resources.failCreates = 1;
    expect(await service.provision(key)).toEqual({ kind: "failed", step: "partyChannel" });
    expect((await r.service.get(key))?.record.pendingResources.map((resource) => resource.kind)).toEqual(["partyChannel", "adventureChannel", "discussionThread"]);

    const retry = await service.provision(key);
    expect(retry.kind).toBe("ok");
    const party = resources.channels.filter((channel) => channel.options.name.endsWith("-stats"));
    expect(party).toHaveLength(1);
    expect(resources.channels.filter((channel) => channel.options.name === "moonlit-ruins")).toHaveLength(1);
  });

  it("keeps the channels when only the thread fails, and finishes on retry", async () => {
    const r = rig();
    const { service, resources } = setup(r);
    await service.setupGuild(guildId, null);
    const key = await newGame(r);
    resources.failThreads = 1;
    expect(await service.provision(key)).toEqual({ kind: "failed", step: "discussionThread" });
    const channelsAfterFailure = resources.channels.length;
    const retry = await service.provision(key);
    expect(retry.kind).toBe("ok");
    expect(resources.channels).toHaveLength(channelsAfterFailure);
    expect(resources.threads).toHaveLength(1);
  });

  it("recreates a channel an administrator deleted, and leaves the rest alone", async () => {
    const r = rig();
    const { service, resources } = setup(r);
    await service.setupGuild(guildId, null);
    const key = await newGame(r);
    await service.provision(key);
    const gone = resources.channels.findIndex((channel) => channel.options.name === "moonlit-ruins");
    resources.channels.splice(gone, 1);
    const again = await service.provision(key);
    expect(again.kind).toBe("ok");
    expect(resources.channels.filter((channel) => channel.options.name === "moonlit-ruins")).toHaveLength(1);
    expect(resources.threads).toHaveLength(1);
  });

  it("names channels in Traditional Chinese from the campaign name", async () => {
    const r = rig();
    const { service, resources } = setup(r);
    await service.setupGuild(guildId, null);
    await service.provision(await newGame(r, "月光遺跡", "zh-TW"));
    expect(resources.channels.map((channel) => channel.options.name)).toEqual(expect.arrayContaining(["月光遺跡", "月光遺跡-stats"]));
    expect(resources.threads[0]?.name).toBe("月光遺跡 — 閒聊討論串");
  });
});
