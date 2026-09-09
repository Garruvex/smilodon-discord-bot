import type { ChatInputCommandInteraction, GuildMember } from "discord.js";

import type { PlaybackActor } from "../../../../application/music/playback-service.js";

export { musicPlaybackAccessPolicy } from "../../../../application/music/music-access-policy.js";

// bypassVoiceChannelCheck is never computed here — it comes from the
// AccessPolicyEngine decision that already authorized this call (see
// AccessDecision.bypassVoiceChannelCheck / access-rules.ts's
// hasMusicDjPrivilege), the same single check both a slash command
// (CommandContext.access, set by CommandDispatcher) and a chat-tool call
// (evaluateMusicToolAccess's return value) already ran. This module stays
// unaware of roles or guild config entirely.
export function createPlaybackActor(
  interaction: ChatInputCommandInteraction<"cached">,
  bypassVoiceChannelCheck: boolean,
  allowQueueWithoutVoiceChannel: boolean,
  voiceChannelIdOverride?: string,
): PlaybackActor {
  return {
    guildId: interaction.guildId,
    textChannelId: interaction.channelId,
    userId: interaction.user.id,
    voiceChannelId: voiceChannelIdOverride ?? interaction.member.voice.channelId,
    bypassVoiceChannelCheck,
    allowQueueWithoutVoiceChannel,
  };
}

// Same shape, built from a plain guild message instead of a slash-command
// interaction — used by the chat tool-calling path (see ChatToolContext.music)
// where the "invocation" is a natural-language mention, not a /command.
export function createPlaybackActorFromMember(
  guildId: string,
  textChannelId: string,
  member: GuildMember,
  bypassVoiceChannelCheck: boolean,
  allowQueueWithoutVoiceChannel: boolean,
): PlaybackActor {
  return {
    guildId,
    textChannelId,
    userId: member.id,
    voiceChannelId: member.voice.channelId,
    bypassVoiceChannelCheck,
    allowQueueWithoutVoiceChannel,
  };
}

// A chat-tool call's ChatToolContext.music.actor is a turn-start snapshot
// (see chat-turn-support.ts's resolveMusicActor) whose bypassVoiceChannelCheck
// and allowQueueWithoutVoiceChannel are always false. Every mutating tool
// binding calls this right after its own evaluateMusicToolAccess() check to
// apply that call's live decision instead, so DJ-mode/open-queue eligibility
// can't go stale across a multi-tool-call turn.
export function withDjBypass(
  actor: PlaybackActor,
  bypassVoiceChannelCheck: boolean,
  allowQueueWithoutVoiceChannel: boolean,
): PlaybackActor {
  return { ...actor, bypassVoiceChannelCheck, allowQueueWithoutVoiceChannel };
}

// Narrower musicController/botAdministrator role check, same semantics as
// the roles clause of musicPlaybackAccessPolicy. The chat-tool path now runs
// the full policy via AccessPolicyEngine (see music-tool-support.ts's
// evaluateMusicToolAccess) rather than this narrower check.
export function memberCanControlMusic(
  member: GuildMember,
  musicControllerRoleIds: ReadonlySet<string>,
  botAdministratorRoleIds: ReadonlySet<string>,
): boolean {
  return member.roles.cache.some((role) =>
    musicControllerRoleIds.has(role.id) || botAdministratorRoleIds.has(role.id));
}
