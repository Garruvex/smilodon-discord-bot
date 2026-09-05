import { ChannelType, PermissionsBitField, type Client, type Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { LavalinkPlayerGateway } from "../../src/infrastructure/lavalink/lavalink-player-gateway.js";
import { MusicChannelAccessError } from "../../src/application/music/music-errors.js";
import type { MusicEventBus } from "../../src/application/music/music-event-bus.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";

const guildId = "123456789012345678";

interface FakePlayer {
  guildId: string;
  voiceChannelId: string | null;
  destroy: ReturnType<typeof vi.fn>;
}

function createFakePlayer(voiceChannelId: string | null): FakePlayer {
  return { guildId, voiceChannelId, destroy: vi.fn().mockResolvedValue(undefined) };
}

const uncachedGuild = Symbol("uncached-guild");

function createGateway(botVoiceChannelId: string | null | typeof uncachedGuild): {
  gateway: LavalinkPlayerGateway;
  stubPlayer: (player: FakePlayer | null) => void;
} {
  const isUncached = botVoiceChannelId === uncachedGuild;
  const guild = {
    id: guildId,
    members: { me: { voice: { channelId: isUncached ? null : botVoiceChannelId } } },
    shard: { send: vi.fn() },
  } as unknown as Guild;
  const client = {
    guilds: {
      cache: isUncached
        ? new Map<string, Guild>()
        : new Map<string, Guild>([[guildId, guild]]),
    },
  } as unknown as Client;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const eventBus = { publish: vi.fn(() => Promise.resolve()) } as unknown as MusicEventBus;
  const guildConfigurationProvider = {
    find: vi.fn(() => undefined),
  } as unknown as GuildConfigurationProvider;

  const gateway = new LavalinkPlayerGateway(
    client,
    { host: "localhost", port: 2333, password: "pw", secure: false },
    logger as never,
    eventBus,
    guildConfigurationProvider,
  );

  const manager = (
    gateway as unknown as { manager: { getPlayer: (id: string) => FakePlayer | undefined } }
  ).manager;

  return {
    gateway,
    stubPlayer: (player: FakePlayer | null): void => {
      manager.getPlayer = vi.fn(() => player ?? undefined);
    },
  };
}

describe("LavalinkPlayerGateway.reconcileVoiceState", () => {
  it("does nothing when there is no player", async () => {
    const { gateway, stubPlayer } = createGateway(null);
    stubPlayer(null);

    await expect(gateway.reconcileVoiceState(guildId)).resolves.toBe(false);
  });

  it("leaves a healthy player alone when the bot's channel matches the player's channel", async () => {
    const { gateway, stubPlayer } = createGateway("111111111111111111");
    const player = createFakePlayer("111111111111111111");
    stubPlayer(player);

    await expect(gateway.reconcileVoiceState(guildId)).resolves.toBe(false);
    expect(player.destroy).not.toHaveBeenCalled();
  });

  it("destroys a stale player after a full voice disconnect", async () => {
    const { gateway, stubPlayer } = createGateway(null);
    const player = createFakePlayer("111111111111111111");
    stubPlayer(player);

    await expect(gateway.reconcileVoiceState(guildId)).resolves.toBe(true);
    expect(player.destroy).toHaveBeenCalledOnce();
  });

  it("destroys a stale player when its channel was deleted out from under it", async () => {
    // A deleted channel surfaces the same way as a disconnect: the bot's
    // real voice state reports no channel, while the Lavalink player still
    // remembers the (now-gone) channel id.
    const { gateway, stubPlayer } = createGateway(null);
    const player = createFakePlayer("deleted-channel-id");
    stubPlayer(player);

    await expect(gateway.reconcileVoiceState(guildId)).resolves.toBe(true);
    expect(player.destroy).toHaveBeenCalledOnce();
  });

  it("destroys a stale player when the bot ends up in a different channel than the player recorded", async () => {
    const { gateway, stubPlayer } = createGateway("222222222222222222");
    const player = createFakePlayer("111111111111111111");
    stubPlayer(player);

    await expect(gateway.reconcileVoiceState(guildId)).resolves.toBe(true);
    expect(player.destroy).toHaveBeenCalledOnce();
  });

  it("treats an uncached guild as unverifiable and does not destroy the player", async () => {
    const { gateway, stubPlayer } = createGateway(uncachedGuild);
    const player = createFakePlayer("111111111111111111");
    stubPlayer(player);

    await expect(gateway.reconcileVoiceState(guildId)).resolves.toBe(false);
    expect(player.destroy).not.toHaveBeenCalled();
  });

  it("propagates a failed destroy instead of silently reporting recovery", async () => {
    const { gateway, stubPlayer } = createGateway(null);
    const player = createFakePlayer("111111111111111111");
    player.destroy.mockRejectedValue(new Error("Lavalink node unreachable"));
    stubPlayer(player);

    await expect(gateway.reconcileVoiceState(guildId)).rejects.toThrow("Lavalink node unreachable");
  });
});

const targetVoiceChannelId = "999999999999999999";

function createGatewayForEnqueue(channelPermissionBits: bigint | null): {
  gateway: LavalinkPlayerGateway;
  createPlayerSpy: ReturnType<typeof vi.fn>;
} {
  const channel = channelPermissionBits === null ? undefined : {
    isVoiceBased: (): boolean => true,
    type: ChannelType.GuildVoice,
    permissionsFor: (): PermissionsBitField => new PermissionsBitField(channelPermissionBits),
  };
  const guild = {
    id: guildId,
    members: { me: { id: "bot-id" } },
    channels: { cache: new Map(channel ? [[targetVoiceChannelId, channel]] : []) },
  } as unknown as Guild;
  const client = {
    guilds: { cache: new Map([[guildId, guild]]) },
  } as unknown as Client;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const eventBus = { publish: vi.fn(() => Promise.resolve()) } as unknown as MusicEventBus;
  const guildConfigurationProvider = {
    find: vi.fn(() => undefined),
  } as unknown as GuildConfigurationProvider;

  const gateway = new LavalinkPlayerGateway(
    client,
    { host: "localhost", port: 2333, password: "pw", secure: false },
    logger as never,
    eventBus,
    guildConfigurationProvider,
  );

  const manager = (
    gateway as unknown as {
      manager: { getPlayer: () => undefined; createPlayer: ReturnType<typeof vi.fn> };
    }
  ).manager;
  manager.getPlayer = vi.fn(() => undefined);
  const createPlayerSpy = vi.fn(() => {
    throw new Error("reached createPlayer");
  });
  manager.createPlayer = createPlayerSpy;

  return { gateway, createPlayerSpy };
}

describe("LavalinkPlayerGateway.enqueue voice-channel access gate", () => {
  // A fresh join (no existing player) is the only case that needs this —
  // assertSameVoiceChannel (PlaybackService) already guarantees the bot is
  // in an existing player's channel, so a repeat enqueue never hits it.
  it("rejects a fresh join when the bot lacks Connect in the target channel", async () => {
    const { gateway, createPlayerSpy } = createGatewayForEnqueue(
      new PermissionsBitField([PermissionsBitField.Flags.ViewChannel]).bitfield,
    );

    await expect(
      gateway.enqueue({
        guildId, voiceChannelId: targetVoiceChannelId, textChannelId: "text-id",
        query: "song", requestedByUserId: "user-id",
      }),
    ).rejects.toBeInstanceOf(MusicChannelAccessError);
    expect(createPlayerSpy).not.toHaveBeenCalled();
  });

  it("rejects a fresh join into a channel the bot can't even see (e.g. deleted or uncached)", async () => {
    const { gateway, createPlayerSpy } = createGatewayForEnqueue(null);

    await expect(
      gateway.enqueue({
        guildId, voiceChannelId: targetVoiceChannelId, textChannelId: "text-id",
        query: "song", requestedByUserId: "user-id",
      }),
    ).rejects.toBeInstanceOf(MusicChannelAccessError);
    expect(createPlayerSpy).not.toHaveBeenCalled();
  });

  it("lets a fresh join through to the player once the bot has full channel access", async () => {
    const { gateway, createPlayerSpy } = createGatewayForEnqueue(
      new PermissionsBitField([
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak,
      ]).bitfield,
    );

    await expect(
      gateway.enqueue({
        guildId, voiceChannelId: targetVoiceChannelId, textChannelId: "text-id",
        query: "song", requestedByUserId: "user-id",
      }),
    ).rejects.toThrow("reached createPlayer");
    expect(createPlayerSpy).toHaveBeenCalledOnce();
  });
});
