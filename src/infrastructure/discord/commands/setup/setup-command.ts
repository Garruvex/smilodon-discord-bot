import { ChannelType, PermissionFlagsBits } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import {
  formatRoleGroupList,
  roleGroupDescriptions,
} from "../../../../application/access/role-group-descriptions.js";
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
      { name: "status", description: "Shows this server's setup status." },
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
    await context.responses.edit(lines.join("\n"));
  }

  private async status(context: CommandContext): Promise<void> {
    if (!context.interaction.guildId) return;
    const status = await this.setupService.status(context.interaction.guildId);

    const permissionLines = status.botPermissions.ok
      ? ["Bot permissions: OK"]
      : [`Bot permissions: MISSING — ${status.botPermissions.missing.join(", ")}`];

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
      ...permissionLines,
      "",
      "Features:",
      ...status.featureStates.map((feature) => `${feature.enabled ? "✅" : "❌"} ${feature.name}`),
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

    if (status.music) {
      lines.push(
        "",
        "Music:",
        `Default volume: ${status.music.defaultVolume} (max ${status.music.maximumVolume}, step ${status.music.volumeButtonStep})`,
        `Empty queue: ${status.music.emptyQueueAction} after ${status.music.emptyQueueDelayMs}ms`,
        `Empty channel: ${status.music.emptyChannelAction} after ${status.music.emptyChannelGracePeriodMs}ms grace`,
        `Resume when occupied: ${status.music.resumeWhenOccupied ? "on" : "off"}`,
      );
    }

    if (status.chat) {
      lines.push(
        "",
        "Chat:",
        `Cooldown: ${status.chat.cooldownSeconds}s (ambient: ${status.chat.ambientCooldownSeconds}s)`,
        `Web search: ${status.chat.webSearchMode}`,
        `Tool calling: ${status.chat.toolCallingEnabled ? "on" : "off"}${status.chat.disabledTools.length > 0 ? ` (${status.chat.disabledTools.length} tool(s) disabled)` : ""}`,
        `Image input: ${status.chat.imageInputEnabled ? "on" : "off"}`,
        `Image generation: ${status.chat.imageGenerationEnabled ? "on" : "off"}`,
        `Include sources: ${status.chat.includeSources ? "on" : "off"}`,
        `Persona drift: ${status.chat.personaDriftEnabled ? "on" : "off"}`,
        `Channel history: limit ${status.chat.channelHistoryLimit}`,
        `Context scan channels: ${status.chat.contextScanChannelIds.length}, daily: ${status.chat.contextDailyChannelIds.length}`,
      );
    }

    if (status.panel) {
      lines.push(
        "",
        "Panel:",
        `Progress bar: ${status.panel.progressBar.style} (length ${status.panel.progressBar.length})`,
      );
    }

    await context.responses.reply({ content: lines.join("\n") });
  }

}
