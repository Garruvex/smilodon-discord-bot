import {
  ActionRowBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type GuildTextBasedChannel,
  type Role,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { Logger } from "pino";

import type { RoleMenuStore } from "./role-menu-store.js";

export type CreateRoleMenuResult = { ok: true } | { ok: false; message: string };

const selectMenuCustomId = "rolemenu:pick";

function validateRole(role: Role, botHighestPosition: number): string | null {
  if (role.id === role.guild.id) return `<@&${role.id}> is the @everyone role and can't be assigned.`;
  if (role.managed) return `<@&${role.id}> is managed by an integration and can't be assigned manually.`;
  if (botHighestPosition <= role.position) {
    return `I can't manage <@&${role.id}> — move my role above it in Server Settings → Roles.`;
  }
  return null;
}

export class RoleMenuService {
  public constructor(
    private readonly store: RoleMenuStore,
    private readonly logger: Logger,
  ) {}

  public async createMenu(
    channel: GuildTextBasedChannel, title: string, roles: readonly Role[],
  ): Promise<CreateRoleMenuResult> {
    const botMember = channel.guild.members.me;
    if (!botMember) return { ok: false, message: "Couldn't resolve my own member in this server." };
    const botHighestPosition = botMember.roles.highest.position;

    for (const role of roles) {
      const error = validateRole(role, botHighestPosition);
      if (error) return { ok: false, message: error };
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId(selectMenuCustomId)
      .setPlaceholder("Choose your roles")
      .setMinValues(0)
      .setMaxValues(roles.length)
      .addOptions(roles.map((role) => ({ label: role.name, value: role.id })));
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

    const message = await channel.send({ content: `**${title}**`, components: [row] });

    await this.store.create({
      guildId: channel.guild.id,
      channelId: channel.id,
      messageId: message.id,
      options: roles.map((role) => ({ roleId: role.id, label: role.name })),
    });

    return { ok: true };
  }

  public async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const menu = await this.store.find(interaction.message.id);
    if (!menu) {
      await interaction.reply({ content: "This role menu is no longer configured.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: "This only works in a server.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const selected = new Set(interaction.values);
    const member = interaction.member;
    const added: string[] = [];
    const removed: string[] = [];

    for (const option of menu.options) {
      const hasRole = member.roles.cache.has(option.roleId);
      const isSelected = selected.has(option.roleId);
      try {
        if (isSelected && !hasRole) {
          await member.roles.add(option.roleId, "Role menu selection");
          added.push(option.label);
        } else if (!isSelected && hasRole) {
          await member.roles.remove(option.roleId, "Role menu deselection");
          removed.push(option.label);
        }
      } catch (error) {
        this.logger.error(
          { error, guildId: menu.guildId, roleId: option.roleId, userId: member.id },
          "Role menu could not update a role",
        );
      }
    }

    const lines = [
      added.length > 0 ? `Added: ${added.join(", ")}` : null,
      removed.length > 0 ? `Removed: ${removed.join(", ")}` : null,
    ].filter((line): line is string => line !== null);

    await interaction.editReply(lines.length > 0 ? lines.join("\n") : "No changes.");
  }
}
