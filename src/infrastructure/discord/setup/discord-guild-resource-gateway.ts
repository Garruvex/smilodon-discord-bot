import { ChannelType, PermissionFlagsBits, PermissionsBitField, type Client } from "discord.js";

import type {
  GuildChannelHandle,
  GuildResourceGateway,
  GuildRoleHandle,
} from "../../../application/setup/guild-resource-gateway.js";
import type { GuildSetupBotPermissionStatus } from "../../../application/setup/guild-setup-service.js";

const requiredBotPermissions = [
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
];

export class DiscordGuildResourceGateway implements GuildResourceGateway {
  public constructor(private readonly client: Client) {}

  public async createRole(guildId: string, name: string, reason: string): Promise<GuildRoleHandle> {
    const guild = await this.client.guilds.fetch(guildId);
    const role = await guild.roles.create({ name, reason });
    return { id: role.id };
  }

  public async deleteRole(guildId: string, roleId: string, reason: string): Promise<void> {
    const guild = await this.client.guilds.fetch(guildId);
    const role = await guild.roles.fetch(roleId);
    await role?.delete(reason);
  }

  public async createTextChannel(
    guildId: string, name: string, topic: string, reason: string,
  ): Promise<GuildChannelHandle> {
    const guild = await this.client.guilds.fetch(guildId);
    const channel = await guild.channels.create({ name, type: ChannelType.GuildText, topic, reason });
    return { id: channel.id };
  }

  public async deleteChannel(guildId: string, channelId: string, reason: string): Promise<void> {
    const guild = await this.client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    await channel?.delete(reason);
  }

  public async fetchTextChannel(guildId: string, channelId: string): Promise<GuildChannelHandle | null> {
    const guild = await this.client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return null;
    return { id: channel.id };
  }

  public async grantRoleIfMissing(guildId: string, memberId: string, roleId: string, reason: string): Promise<void> {
    const guild = await this.client.guilds.fetch(guildId);
    const member = await guild.members.fetch(memberId);
    if (!member.roles.cache.has(roleId)) {
      await member.roles.add(roleId, reason);
    }
  }

  public async checkBotPermissions(guildId: string): Promise<GuildSetupBotPermissionStatus> {
    const guild = await this.client.guilds.fetch(guildId);
    const botMember = guild.members.me;
    const missingFlags = requiredBotPermissions.filter((flag) => !botMember?.permissions.has(flag));
    const missing = new PermissionsBitField(missingFlags).toArray();
    return { ok: missing.length === 0, missing };
  }
}
