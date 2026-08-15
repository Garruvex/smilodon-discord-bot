import type { ChatInputCommandInteraction } from "discord.js";

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
