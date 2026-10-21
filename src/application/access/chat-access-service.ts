import type { GuildMember } from "discord.js";

import type { ApplicationConfiguration } from "../../config/configuration.js";
import type { GuildConfiguration } from "../../config/guild-configuration.js";

export type MentionChatAccessReason = "allowed" | "member_unavailable" | "restricted_role" | "channel_denied" | "missing_chat_role";

export class ChatAccessService {
  public constructor(private readonly configuration: ApplicationConfiguration) {}

  public canUseMentionChat(
    profile: GuildConfiguration,
    member: GuildMember | null,
    userId: string,
    channelId: string,
  ): boolean {
    return this.mentionChatAccessReason(profile, member, userId, channelId) === "allowed";
  }

  public mentionChatAccessReason(
    profile: GuildConfiguration,
    member: GuildMember | null,
    userId: string,
    channelId: string,
  ): MentionChatAccessReason {
    if (!member) {
      return "member_unavailable";
    }

    const isOwner = this.configuration.ownerUserIds.has(userId);
    const memberRoleIds = member.roles.cache;

    if (this.hasAnyRole(memberRoleIds, profile.roles.restricted, profile.guildId) && !isOwner) {
      return "restricted_role";
    }

    // Owners bypass the same channel allow-list that AccessPolicyService's owner
    // bypass skips for slash commands, so bot owners aren't locked out of mention
    // chat outside the guild's configured chatbot channels.
    if (isOwner) {
      return "allowed";
    }

    if (profile.channels.chatbot.size > 0 && !profile.channels.chatbot.has(channelId)) {
      return "channel_denied";
    }

    return (
      this.hasAnyRole(memberRoleIds, profile.roles.chatbot, profile.guildId) ||
      this.hasAnyRole(memberRoleIds, profile.roles.botAdministrator, profile.guildId)
    ) ? "allowed" : "missing_chat_role";
  }

  public canCollectContext(profile: GuildConfiguration, userId: string, member: GuildMember | null): boolean {
    if (profile.chat.contextOptOutUserIds?.includes(userId)) return false;
    const roles = profile.chat.contextOptOutRoleIds ?? [];
    // No membership lookup is necessary when there are no role exclusions.
    if (!roles.length) return true;
    return !!member && !this.hasAnyRole(member.roles.cache, new Set(roles), profile.guildId);
  }

  private hasAnyRole(
    memberRoles: GuildMember["roles"]["cache"],
    configuredRoleIds: ReadonlySet<string>,
    guildId: string,
  ): boolean {
    // Discord's @everyone role ID is the guild ID. Membership is implicit;
    // a partial guild-role cache must not turn it into an opt-in role.
    if (configuredRoleIds.has(guildId)) return true;
    for (const roleId of configuredRoleIds) {
      if (memberRoles.has(roleId)) {
        return true;
      }
    }
    return false;
  }
}
