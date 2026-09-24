import { ChannelType, PermissionFlagsBits } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { roleGroupDescriptions } from "../../../../application/access/role-group-descriptions.js";
import type { GuildSetupService } from "../../../../application/setup/guild-setup-service.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

export class SetupCommand implements BotCommand {
  public readonly definition = {
    name: "setup",
    description: "Configures this server for the bot.",
    dmPermission: false,
    subcommands: [
      {
        name: "initialize",
        description: "Creates or adopts roles and a persistent music channel.",
        options: [
          { type: "string", name: "display-name", description: "Display name used by this server profile.", maxLength: 80 },
          { type: "string", name: "idle-image-url", description: "Stable HTTPS image URL shown when nothing is playing." },
          {
            type: "channel", name: "control-channel",
            description: "Existing music control channel; one is created if omitted.",
            guildTextOnly: true,
          },
          { type: "role", name: "administrator-role", description: "Existing bot administrator role; one is created if omitted." },
          {
            type: "role", name: "music-controller-role",
            description: "Role for /play, queue commands, panel controls, and typed control-channel requests.",
          },
          { type: "role", name: "restricted-role", description: "Role denied from music and chatbot unless bot-owner bypass applies." },
        ],
      },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Bootstrap;
  public readonly access = {
    ...publicAccessPolicy,
    allowUnconfiguredGuild: true,
    requiredMemberPermissions: [PermissionFlagsBits.ManageGuild],
  };

  public constructor(private readonly setupService: GuildSetupService) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) {
      await context.responses.reply("Setup is only available in a server.");
      return;
    }

    const subcommand = context.interaction.options.getSubcommand(true);
    switch (subcommand) {
      case "initialize":
        await this.initialize(context);
        return;
      default:
        throw new Error(`Unsupported setup subcommand: ${subcommand}`);
    }
  }

  private async initialize(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    await context.responses.defer();

    const selectedChannel = context.interaction.options.getChannel("control-channel");
    const controlChannel = selectedChannel?.type === ChannelType.GuildText
      ? selectedChannel
      : null;

    const result = await this.setupService.initialize({
      guildId: context.interaction.guild.id,
      guildName: context.interaction.guild.name,
      initializedByUserId: context.interaction.member.id,
      displayName:
        context.interaction.options.getString("display-name") ??
        context.interaction.client.user.username,
      idleImageUrl: context.interaction.options.getString("idle-image-url"),
      controlChannelId: controlChannel?.id ?? null,
      botAdministratorRoleId:
        context.interaction.options.getRole("administrator-role")?.id ?? null,
      musicControllerRoleId:
        context.interaction.options.getRole("music-controller-role")?.id ?? null,
      restrictedRoleId: context.interaction.options.getRole("restricted-role")?.id ?? null,
    });

    const lines = [
      result.wasFreshSetup
        ? "Server setup completed."
        : "This server was already configured — resumed/refreshed the existing setup (no new roles or channel were created).",
      `Control channel: <#${result.controlChannelId}>`,
      `Bot administrator: <@&${result.botAdministratorRoleId}>`,
      `Music controller: <@&${result.musicControllerRoleId}>`,
      `Restricted role: <@&${result.restrictedRoleId}>`,
      `Synchronized commands: ${result.deployedCommandCount}`,
    ];
    if (result.wasFreshSetup) {
      lines.push(
        "",
        "Access configured:",
        `- Bot administrator: ${roleGroupDescriptions.botAdministrator}`,
        `- Music controller: ${roleGroupDescriptions.musicController}`,
        `- Restricted: ${roleGroupDescriptions.restricted}`,
        "",
        "You were granted bot administrator and music controller.",
        `Assign <@&${result.musicControllerRoleId}> to members who should queue music.`,
      );
    }
    lines.push("", "Run `/status` any time to check the setup.");
    await context.responses.edit(lines.join("\n"));
  }
}
