import type { ChatInputCommandInteraction, GuildMember } from "discord.js";

import type { PlaybackActor } from "../../../../application/music/playback-service.js";

export { musicPlaybackAccessPolicy } from "../../../../application/music/music-access-policy.js";

export function createPlaybackActor(
  interaction: ChatInputCommandInteraction<"cached">,
): PlaybackActor {
  return {
    guildId: interaction.guildId,
    textChannelId: interaction.channelId,
    userId: interaction.user.id,
    member: interaction.member,
  };
}

// Same shape, built from a plain guild message instead of a slash-command
// interaction — used by the chat tool-calling path (see ChatToolContext.music)
// where the "invocation" is a natural-language mention, not a /command.
export function createPlaybackActorFromMember(
  guildId: string,
  textChannelId: string,
  member: GuildMember,
): PlaybackActor {
  return {
    guildId,
    textChannelId,
    userId: member.id,
    member,
  };
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
