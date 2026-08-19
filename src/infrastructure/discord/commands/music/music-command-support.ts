import type { ChatInputCommandInteraction, GuildMember } from "discord.js";

import type { PlaybackActor } from "../../../../application/music/playback-service.js";
import {
  RoleMatchMode,
  publicAccessPolicy,
  type CommandAccessPolicy,
} from "../../../../domain/access/access-policy.js";

export const musicPlaybackAccessPolicy: CommandAccessPolicy = {
  ...publicAccessPolicy,
  roles: {
    match: RoleMatchMode.Any,
    requiredGroups: ["musicController"],
  },
};

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

// Whether a member is allowed to invoke music tools via chat — the same role
// gate musicPlaybackAccessPolicy applies to /play etc. (musicController or
// botAdministrator), since chat-invoked tools bypass the normal command
// access-policy pipeline entirely.
export function memberCanControlMusic(
  member: GuildMember,
  musicControllerRoleIds: ReadonlySet<string>,
  botAdministratorRoleIds: ReadonlySet<string>,
): boolean {
  return member.roles.cache.some((role) =>
    musicControllerRoleIds.has(role.id) || botAdministratorRoleIds.has(role.id));
}
