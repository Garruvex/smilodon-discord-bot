import { describe, expect, it } from "vitest";

import { enSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { starterAdventureId } from "../../../../src/infrastructure/campaign/starter-adventures.js";
import { CampaignCardService } from "../../../../src/infrastructure/discord/campaign/campaign-card-service.js";
import { CampaignSetupService } from "../../../../src/infrastructure/discord/campaign/campaign-setup-service.js";
import { guildId, quiet, rig, type Rig } from "../../../application/campaign/campaign-rig.js";
import { flatten } from "./card-helpers.js";
import { FakeMessages } from "./fake-messages.js";
import { FakeResources } from "./fake-resources.js";

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
    resources,
  });
  return { resources, messages, service: new CampaignSetupService({ unitOfWork: r.store, resources, cards, logger: quiet }) };
}

async function newGame(r: Rig, name = "Moonlit Ruins", language: "en" | "zh-TW" = "en"): Promise<{ guildId: string; campaignId: string }> {
  const created = await r.service.create({ guildId, organizerId: "u-org", name, language, adventureId: starterAdventureId, pacing: { preset: "live" } });
  if (created.kind !== "ok") throw new Error("create");
  return created.value.key;
}

describe("server setup", () => {
  it("creates a Traditional Chinese D&D space and retains its language on repair", async () => {
    const r = rig();
    const { service, resources, messages } = setup(r);
    const first = await service.setupGuild(guildId, null, "zh-TW");
    if (first.kind !== "ok") throw new Error("setup");
    expect(first.settings.language).toBe("zh-TW");
    expect(resources.categoryNames).toEqual(["龍與地下城"]);
    expect(resources.channels[0]?.options).toMatchObject({ name: "龍與地下城-團務", topic: "本伺服器的龍與地下城團務" });
    expect(resources.forums.map((forum) => forum.options.name)).toEqual(["公開遊戲", "公開隊伍", "私人遊戲", "私人隊伍"]);
    expect(resources.forums[0]?.options.topic).toBe("龍與地下城 公開遊戲");
    expect(flatten(messages.live(first.settings.hubChannelId!)[0]!.payload).text).toContain("還沒有團務");
    const repaired = await service.setupGuild(guildId, null);
    expect(repaired.kind === "ok" && repaired.settings.language).toBe("zh-TW");
    expect(resources.categories.size).toBe(1);
  });

  it("creates the D&D category, the four campaign forums, and a read-only hub channel, and lists games there", async () => {
    const r = rig();
    const { service, resources, messages } = setup(r);
    const result = await service.setupGuild(guildId, null);
    if (result.kind !== "ok") throw new Error("setup");
    expect(resources.categories.size).toBe(1);
    expect(resources.channels).toHaveLength(1);
    expect(resources.channels[0]?.options).toMatchObject({ name: "dnd-games" });
    // Every D&D channel is locked to players, the picked hub and the private forums' viewer role included.
    expect(resources.locked.map((lock) => lock.channelId).sort()).toEqual([result.settings.hubChannelId, result.settings.publicGamesForumId, result.settings.publicPartiesForumId, result.settings.privateGamesForumId, result.settings.privatePartiesForumId].sort());
    expect(resources.locked.find((lock) => lock.channelId === result.settings.privateGamesForumId)?.roleId).toBe(result.settings.privateGamesRoleId);
    expect(resources.forums.map((forum) => forum.options.name)).toEqual(["public-games", "public-parties", "private-games", "private-parties"]);
    expect(resources.forums.find((forum) => forum.options.name === "public-games")?.options.tags).toEqual(["Recruiting", "Active", "Paused", "Completed"]);
    expect(resources.forums.find((forum) => forum.options.name === "public-parties")?.options.tags).toEqual([]);
    expect(resources.forums.find((forum) => forum.options.name === "private-games")?.options.viewerRoleId).toBeTruthy();
    expect(result.settings).toMatchObject({ categoryId: "cat1", hubChannelId: "ch2" });
    expect(flatten(messages.live("ch2")[0]!.payload).text).toContain("No games yet");
    // The hub is the door to the rest of the category, so it is put first, above the forums made after it.
    expect(resources.placedFirst).toEqual(["ch2"]);
    expect(messages.pinned).toContain(messages.live("ch2")[0]!.messageId);
  });

  it("creates the DnD Admin and Private Games roles once, and makes them again when deleted", async () => {
    const r = rig();
    const { service, resources } = setup(r);
    const first = await service.setupGuild(guildId, null);
    if (first.kind !== "ok") throw new Error("setup");
    const roleId = first.settings.adminRoleId;
    expect(roleId).toBeTruthy();
    expect(first.settings.privateGamesRoleId).toBeTruthy();
    expect(resources.roles.size).toBe(2);

    const again = await service.setupGuild(guildId, null);
    expect(again.kind === "ok" && again.settings.adminRoleId).toBe(roleId);
    expect(resources.roles.size).toBe(2);

    resources.roles.clear();
    const repaired = await service.setupGuild(guildId, null);
    expect(repaired.kind === "ok" && repaired.settings.adminRoleId).not.toBe(roleId);
    expect(resources.roles.size).toBe(2);
  });

  it("uses the channel the organizer ran it in as the hub, and keeps the category on a repeat", async () => {
    const r = rig();
    const { service, resources } = setup(r);
    resources.channels.push({ id: "mine", options: { name: "general", topic: "", parentId: null } });
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
    expect(resources.forums).toHaveLength(0);
  });
});

describe("creating a game's posts", () => {
  it("makes the Games and Parties forum posts, tagged Recruiting for a new game", async () => {
    const r = rig();
    const { service, resources, messages } = setup(r);
    await service.setupGuild(guildId, null);
    const key = await newGame(r);
    const result = await service.provision(key);
    if (result.kind !== "ok") throw new Error(`provision: ${result.kind}`);

    const publicGames = resources.forums.find((forum) => forum.options.name === "public-games");
    const publicParties = resources.forums.find((forum) => forum.options.name === "public-parties");
    const adventure = resources.forumPosts.find((post) => post.forumId === publicGames?.id);
    const party = resources.forumPosts.find((post) => post.forumId === publicParties?.id);
    expect(adventure?.name).toBe("Moonlit Ruins");
    expect(party?.name).toBe("Moonlit Ruins — Party");
    expect(adventure?.tag).toBe("Recruiting");
    expect(result.record.channels).toMatchObject({ partyPostId: party?.id, adventurePostId: adventure?.id });
    expect(result.record.pendingResources.map((resource) => [resource.kind, resource.resourceId !== null])).toEqual([
      ["adventurePost", true],
      ["partyPost", true],
    ]);
    // The lobby card is on the Party post and the hub lists the game.
    expect(flatten(messages.live(party?.id ?? "")[0]!.payload).text).toContain("Moonlit Ruins — Lobby");
  });

  it("puts a members-only game's posts in the private forums instead", async () => {
    const r = rig();
    const { service, resources } = setup(r);
    await service.setupGuild(guildId, null);
    const created = await r.service.create({ guildId, organizerId: "u-org", name: "Secret Table", language: "en", adventureId: starterAdventureId, pacing: { preset: "live" }, visibility: "membersOnly" });
    if (created.kind !== "ok") throw new Error("create");
    const result = await service.provision(created.value.key);
    if (result.kind !== "ok") throw new Error(`provision: ${result.kind}`);

    const privateGames = resources.forums.find((forum) => forum.options.name === "private-games");
    const privateParties = resources.forums.find((forum) => forum.options.name === "private-parties");
    expect(resources.forumPosts.some((post) => post.forumId === privateGames?.id && post.name === "Secret Table")).toBe(true);
    expect(resources.forumPosts.some((post) => post.forumId === privateParties?.id)).toBe(true);
  });

  it("allows a second game with the same name as the first (forum posts need no unique name)", async () => {
    const r = rig();
    const { service, resources } = setup(r);
    await service.setupGuild(guildId, null);
    const first = await newGame(r);
    await service.provision(first);
    // A finished game frees the campaign name.
    await r.service.cancel(first, "u-org");
    const second = await newGame(r);
    const result = await service.provision(second);
    expect(result.kind).toBe("ok");
    expect(resources.forumPosts.filter((post) => post.name === "Moonlit Ruins")).toHaveLength(2);
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
    const before = resources.forumPosts.length;
    resources.missing = ["CreatePublicThreads"];
    expect(await service.provision(key)).toEqual({ kind: "missingPermissions", missing: ["CreatePublicThreads"] });
    expect(resources.forumPosts).toHaveLength(before);
  });

  it("resumes after a failure without duplicating what was already made", async () => {
    const r = rig();
    const { service, resources } = setup(r);
    await service.setupGuild(guildId, null);
    const key = await newGame(r);
    // The Games post is created on Discord but the answer is lost.
    resources.failForumPostCreates = 1;
    expect(await service.provision(key)).toEqual({ kind: "failed", step: "adventurePost" });
    expect((await r.service.get(key))?.record.pendingResources.map((resource) => resource.kind)).toEqual(["adventurePost", "partyPost"]);

    const retry = await service.provision(key);
    expect(retry.kind).toBe("ok");
    expect(resources.forumPosts.filter((post) => post.name === "Moonlit Ruins")).toHaveLength(1);
    expect(resources.forumPosts.filter((post) => post.name === "Moonlit Ruins — Party")).toHaveLength(1);
  });

  it("recreates a post an administrator deleted, and leaves the rest alone", async () => {
    const r = rig();
    const { service, resources } = setup(r);
    await service.setupGuild(guildId, null);
    const key = await newGame(r);
    await service.provision(key);
    const gone = resources.forumPosts.findIndex((post) => post.name === "Moonlit Ruins");
    resources.forumPosts.splice(gone, 1);
    const again = await service.provision(key);
    expect(again.kind).toBe("ok");
    expect(resources.forumPosts.filter((post) => post.name === "Moonlit Ruins")).toHaveLength(1);
    expect(resources.forumPosts.filter((post) => post.name === "Moonlit Ruins — Party")).toHaveLength(1);
  });

  it("names posts in Traditional Chinese from the campaign name", async () => {
    const r = rig();
    const { service, resources } = setup(r);
    await service.setupGuild(guildId, null);
    await service.provision(await newGame(r, "月光遺跡", "zh-TW"));
    expect(resources.forumPosts.map((post) => post.name)).toEqual(expect.arrayContaining(["月光遺跡", "月光遺跡 — 隊伍"]));
  });
});
