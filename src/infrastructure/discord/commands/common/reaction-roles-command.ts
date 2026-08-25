import { PermissionFlagsBits } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { RoleMenuService } from "../../../../application/roles/role-menu-service.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

const maxRoles = 5;

export class ReactionRolesCommand implements BotCommand {
  public readonly definition = {
    name: "reactionroles",
    description: "Sets up a role-picker menu.",
    subcommands: [
      {
        name: "create",
        description: "Posts a role-picker menu in a channel.",
        options: [
          { type: "channel", name: "channel", description: "Where to post the menu.", required: true, guildTextOnly: true },
          { type: "string", name: "title", description: "Menu title.", required: true, maxLength: 100 },
          { type: "role", name: "role1", description: "A role members can pick.", required: true },
          { type: "role", name: "role2", description: "Another role members can pick." },
          { type: "role", name: "role3", description: "Another role members can pick." },
          { type: "role", name: "role4", description: "Another role members can pick." },
          { type: "role", name: "role5", description: "Another role members can pick." },
        ],
      },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Common;
  public readonly access = {
    ...publicAccessPolicy,
    requiredMemberPermissions: [PermissionFlagsBits.ManageRoles],
  };

  public constructor(private readonly roleMenuService: RoleMenuService) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) {
      await context.responses.reply("This only works in a server.");
      return;
    }

    const channel = context.interaction.options.getChannel("channel", true);
    if (!channel.isTextBased()) {
      await context.responses.reply("That channel isn't usable for a role menu.");
      return;
    }

    const title = context.interaction.options.getString("title", true);
    const roles = [];
    for (let i = 1; i <= maxRoles; i++) {
      const role = context.interaction.options.getRole(`role${i}`);
      if (role) roles.push(role);
    }

    const resolvedRoles = [];
    for (const role of roles) {
      const resolved = await context.interaction.guild.roles.fetch(role.id).catch(() => null);
      if (!resolved) {
        await context.responses.reply(`Couldn't resolve role <@&${role.id}>.`);
        return;
      }
      resolvedRoles.push(resolved);
    }

    const result = await this.roleMenuService.createMenu(channel, title, resolvedRoles);
    if (!result.ok) {
      await context.responses.reply(result.message);
      return;
    }

    await context.responses.reply(`Role menu posted in <#${channel.id}>.`);
  }
}
