import { describe, expect, it, vi } from "vitest";
import { ReviewedMusicTool } from "../../src/infrastructure/discord/commands/music/reviewed-music-tool.js";
import { PauseCommand } from "../../src/infrastructure/discord/commands/music/pause-command.js";
import { QueueCommand } from "../../src/infrastructure/discord/commands/music/queue-command.js";
import { guardedToolResourcePort, guardedTools } from "../../src/application/chat/guarded-tool-gateway.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { ChatToolRegistry } from "../../src/application/chat/tools/chat-tool-registry.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import type { ChatToolContext } from "../../src/application/chat/tools/chat-tool.js";
import type { PlaybackService } from "../../src/application/music/playback-service.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import type { BotCommand } from "../../src/application/commands/command.js";
import { guardedFixture } from "../helpers/guarded-context-fixture.js";

const profile = { features: { music: true }, channels: { musicCommands: new Set() }, roles: {
  restricted: new Set(), musicController: new Set(["dj"]), botAdministrator: new Set(),
}, music: { maximumVolume: 100, openQueueRequestsEnabled: false } };
const profiles = { find: () => profile } as unknown as GuildConfigurationProvider;
function music(): NonNullable<ChatToolContext["music"]> {
  return { actor: { guildId: "guild", textChannelId: "channel", userId: "alice", voiceChannelId: "voice", bypassVoiceChannelCheck: false, allowQueueWithoutVoiceChannel: false },
    resolveAccessSubjectFields: vi.fn(() => ({ roleIds: ["dj"], memberPermissions: -1n, botPermissions: -1n })),
    volumeMaximum: 100, musicControllerRoleIds: new Set(["dj"]), botAdministratorRoleIds: new Set() };
}
async function setup(service: Partial<PlaybackService>, queue = false): Promise<{
  fixture: ReturnType<typeof guardedFixture>; context: ChatToolContext; lease: GuardedConversationContext;
  tool: NonNullable<ReturnType<typeof guardedTools>[number]>; check: () => Promise<void>;
}> {
  const fixture = guardedFixture(); const command = queue ? new QueueCommand(service as PlaybackService, profiles) : new PauseCommand(service as PlaybackService, profiles);
  const tool = ReviewedMusicTool.from(command)!; const registry = new ChatToolRegistry([tool]);
  const context: ChatToolContext = { guildId: "guild", channelId: "channel", currentUser: fixture.actors.get("alice")!, channelIsNsfw: false, channelMode: "shared", isOwner: false, music: music(), pendingGeneratedImages: [] };
  const lease = await GuardedConversationContext.open(guardedToolResourcePort(fixture.port, registry, context), { count: 0, budget: 4000, burstIds: [] });
  const check = async (): Promise<void> => { if (!await lease.validate()) throw new SocialOutputSuppressed(); };
  const tools = guardedTools(registry, lease, { enabled: true, guildId: "guild", channelId: "channel", userId: "alice" }, check, vi.fn(), context);
  return { fixture, context, lease, tool: tools[0]!, check };
}

describe("guarded music sources and effects", () => {
  it("requires a reviewed command instance, rejecting an identical-looking binding", () => {
    const command = new PauseCommand({} as PlaybackService, profiles);
    expect(ReviewedMusicTool.from({ ...command } as BotCommand)).toBeNull();
  });
  it.each(["allowed", "source_revoked", "role_revoked"] as const)("rechecks access before playback: %s", async (scenario) => {
    const pause = vi.fn().mockResolvedValue(undefined); const { fixture, context, tool } = await setup({ pause });
    if (scenario === "source_revoked") fixture.denied.add("current");
    if (scenario === "role_revoked") vi.mocked(context.music!.resolveAccessSubjectFields).mockReturnValue({ roleIds: [], memberPermissions: -1n, botPermissions: -1n });
    const call = tool.execute({}, context);
    if (scenario === "source_revoked") await expect(call).rejects.toBeInstanceOf(SocialOutputSuppressed);
    else expect((await call).content).toContain(scenario === "allowed" ? "paused" : "music-controller");
    expect(pause).toHaveBeenCalledTimes(scenario === "allowed" ? 1 : 0);
  });
  it.each(["eligible", "other_channel", "revoked"] as const)("authorizes queue entries and destination before contextual disclosure: %s", async (scenario) => {
    const publicTrack = { title: "PUBLIC_TRACK", author: "artist", requestedByUserId: "alice" };
    const hiddenTrack = { title: "HIDDEN_TRACK", author: "HIDDEN_ARTIST", requestedByUserId: "hidden" };
    const snapshot = { guildId: "guild", textChannelId: scenario === "other_channel" ? "elsewhere" : "channel", currentTrack: publicTrack, playing: true, paused: false, volume: 100 };
    const { fixture, context, lease, tool } = await setup({ getSnapshot: () => snapshot, getQueue: () => [hiddenTrack, publicTrack] } as unknown as Partial<PlaybackService>, true);
    const result = await tool.execute({}, context);
    expect(result.content).not.toContain("HIDDEN_");
    if (scenario === "other_channel") { expect(result.content).toContain("unavailable"); return; }
    expect(JSON.parse(result.content)).toMatchObject({ visibleQueuedCount: 1, complete: false, currentTrack: { title: "PUBLIC_TRACK" } });
    expect(lease.provenance("queue")?.resources?.[0]?.kind).toBe("music_queue");
    if (scenario === "revoked") fixture.actors.delete("alice");
    expect(await lease.validate()).toBe(scenario !== "revoked");
  });
  it("uses turn authority rather than caller-supplied tool privileges", async () => {
    const pause = vi.fn(); const { context, tool } = await setup({ pause });
    vi.mocked(context.music!.resolveAccessSubjectFields).mockReturnValue({ roleIds: [], memberPermissions: -1n, botPermissions: -1n });
    await tool.execute({}, { ...context, isOwner: true, music: music() });
    expect(pause).not.toHaveBeenCalled();
  });
});
