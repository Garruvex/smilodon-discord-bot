import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import {
  formatRoleGroupList,
  roleGroupDescriptions,
} from "../../../../application/access/role-group-descriptions.js";
import type { GuildSetupService } from "../../../../application/setup/guild-setup-service.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

export class SetupCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configures this server for the bot.")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("initialize")
        .setDescription("Creates or adopts roles and a persistent music channel.")
        .addStringOption((option) =>
          option
            .setName("display-name")
            .setDescription("Display name used by this server profile.")
            .setMaxLength(80),
        )
        .addStringOption((option) =>
          option
            .setName("idle-image-url")
            .setDescription("Stable HTTPS image URL shown when nothing is playing."),
        )
        .addChannelOption((option) =>
          option
            .setName("control-channel")
            .setDescription("Existing music control channel; one is created if omitted.")
            .addChannelTypes(ChannelType.GuildText),
        )
        .addRoleOption((option) =>
          option
            .setName("administrator-role")
            .setDescription("Existing bot administrator role; one is created if omitted."),
        )
        .addRoleOption((option) =>
          option
            .setName("music-controller-role")
            .setDescription(
              "Role for /play, queue commands, panel controls, and typed control-channel requests.",
            ),
        )
        .addRoleOption((option) =>
          option
            .setName("restricted-role")
            .setDescription("Role denied from music and chatbot unless bot-owner bypass applies."),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("status").setDescription("Shows this server's setup status."),
    );

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
      case "status":
        await this.status(context);
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
      guild: context.interaction.guild,
      initializedBy: context.interaction.member,
      displayName:
        context.interaction.options.getString("display-name") ??
        context.interaction.client.user.username,
      idleImageUrl: context.interaction.options.getString("idle-image-url"),
      controlChannel,
      botAdministratorRole:
        context.interaction.options.getRole("administrator-role"),
      musicControllerRole:
        context.interaction.options.getRole("music-controller-role"),
      restrictedRole: context.interaction.options.getRole("restricted-role"),
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
    await context.responses.edit(lines.join("\n"));
  }

  private async status(context: CommandContext): Promise<void> {
    if (!context.interaction.guildId) return;
    const status = this.setupService.status(
      context.interaction.guildId,
      context.interaction.inCachedGuild() ? context.interaction.guild : undefined,
    );

    const permissionLines = status.botPermissions
      ? status.botPermissions.ok
        ? ["Bot permissions: OK"]
        : [`Bot permissions: MISSING — ${status.botPermissions.missing.join(", ")}`]
      : [];

    if (!status.configured) {
      await context.responses.reply({
        content: [
          "This server has not been configured. Run `/setup initialize`.",
          ...permissionLines,
        ].join("\n"),
      });
      return;
    }

    const lines = [
      "This server is configured.",
      `Profile: ${status.profileFile ?? "unknown"}`,
      `Control panel: ${status.controlPanelChannelId ? `<#${status.controlPanelChannelId}>` : "disabled"}`,
      `Features: ${status.enabledFeatures.join(", ")}`,
      ...permissionLines,
    ];

    if (status.access) {
      lines.push(
        "",
        "Configured access roles:",
        `Bot administrator: ${formatRoleGroupList(status.access.botAdministrator)}`,
        `Music controller: ${formatRoleGroupList(status.access.musicController)}`,
        `Restricted: ${formatRoleGroupList(status.access.restricted)}`,
        `Chatbot: ${formatRoleGroupList(status.access.chatbot)}`,
        "",
        "Role purposes:",
        `- Bot administrator: ${roleGroupDescriptions.botAdministrator}`,
        `- Music controller: ${roleGroupDescriptions.musicController}`,
        `- Restricted: ${roleGroupDescriptions.restricted}`,
        `- Chatbot: ${roleGroupDescriptions.chatbot}`,
      );
    }

    await context.responses.reply({ content: lines.join("\n") });
  }

}
