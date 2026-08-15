import type { GuildMember } from "discord.js";

import type { ApplicationConfiguration } from "../../config/configuration.js";
import type { GuildConfiguration } from "../../config/guild-configuration.js";

export class ChatAccessService {
  public constructor(private readonly configuration: ApplicationConfiguration) {}

  public canUseMentionChat(
    profile: GuildConfiguration,
    member: GuildMember | null,
    userId: string,
    channelId: string,
  ): boolean {
    if (profile.channels.chatbot.size > 0 && !profile.channels.chatbot.has(channelId)) {
      return false;
    }
    if (!member) {
      return false;
    }

    const memberRoleIds = member.roles.cache;
    if (
      this.hasAnyRole(memberRoleIds, profile.roles.restricted) &&
      !this.configuration.ownerUserIds.has(userId)
    ) {
      return false;
    }

    if (this.configuration.ownerUserIds.has(userId)) {
      return true;
    }

    return (
      this.hasAnyRole(memberRoleIds, profile.roles.chatbot) ||
      this.hasAnyRole(memberRoleIds, profile.roles.botAdministrator)
    );
  }

  private hasAnyRole(
    memberRoles: GuildMember["roles"]["cache"],
    configuredRoleIds: ReadonlySet<string>,
  ): boolean {
    for (const roleId of configuredRoleIds) {
      if (memberRoles.has(roleId)) {
        return true;
      }
    }
    return false;
  }
}
