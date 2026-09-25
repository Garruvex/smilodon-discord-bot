import { EmbedBuilder, PermissionFlagsBits } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { formatRoleGroupList } from "../../../../application/access/role-group-descriptions.js";
import type { AdminPanelHealth, AdminPanelIssue } from "../../../../application/settings/admin-panel-health.js";
import type { Texts } from "../../../../application/i18n/texts.js";
import type { GuildSetupService } from "../../../../application/setup/guild-setup-service.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

// Instance-wide model wiring (env config, not per-guild) — secrets stripped
// at the wiring site so this command never sees an API key.
export interface ChatModelSummary {
  chat: { provider: string; models: readonly string[]; summaryModels: readonly string[] } | null;
  utility: { provider: string; models: readonly string[] } | null;
  embeddings: { provider: string; model: string } | null;
}

type StatusText = Texts["setup"]["status"];

const onOff = (text: StatusText, enabled: boolean): string => (enabled ? text.on : text.off);

function formatDuration(text: StatusText, ms: number): string {
  if (ms <= 0) return text.duration.now;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return text.duration.seconds({ seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? text.duration.minutes({ minutes }) : text.duration.minutesSeconds({ minutes, seconds: rest });
}

function describePanelIssue(text: StatusText, issue: AdminPanelIssue): string {
  switch (issue.kind) {
    case "missing-permissions":
      return text.panelIssue.missingPermissions({ permissions: issue.permissions.join(", "), channel: `<#${issue.channelId}>` });
    case "cannot-lock":
      return text.panelIssue.cannotLock({ channel: `<#${issue.channelId}>` });
    case "healing-paused":
      return text.panelIssue.healingPaused;
    case "channel-deleted":
      return text.panelIssue.channelDeleted;
  }
}

function formatRoles(text: StatusText, roleIds: ReadonlySet<string>): string {
  return roleIds.size === 0 ? text.role.none : formatRoleGroupList(roleIds);
}

function formatModelChain(text: StatusText, models: readonly string[]): string {
  const [primary, ...fallbacks] = models;
  const head = `\`${primary ?? text.none}\``;
  return fallbacks.length > 0
    ? `${head}\n${text.model.fallbacks({ models: fallbacks.map((model) => `\`${model}\``).join(" → ") })}`
    : head;
}

export class StatusCommand implements BotCommand {
  public readonly definition = {
    name: "status",
    description: "Shows how the bot is set up in this server, including the current chat model.",
    dmPermission: false,
  } satisfies BotCommand["definition"];

  // Bootstrap so it's deployed (and usable) before /setup initialize has run.
  public readonly module = CommandModule.Bootstrap;
  public readonly access = {
    ...publicAccessPolicy,
    allowUnconfiguredGuild: true,
    requiredMemberPermissions: [PermissionFlagsBits.ManageGuild],
  };

  public constructor(
    private readonly setupService: GuildSetupService,
    private readonly profiles: GuildConfigurationProvider,
    private readonly adminPanelHealth: AdminPanelHealth,
    private readonly models: ChatModelSummary,
  ) {}

  public async execute(context: CommandContext): Promise<void> {
    const text = context.text.setup.status;
    const guildId = context.interaction.guildId;
    if (!guildId) {
      await context.responses.reply(text.guildOnly);
      return;
    }

    const status = await this.setupService.status(guildId);
    const embedColor = (this.profiles.find(guildId)?.embedColor ?? "#3B82F6") as `#${string}`;
    const permissions = status.botPermissions.ok
      ? text.permissionsOk
      : text.permissionsMissing({ permissions: status.botPermissions.missing.join(", ") });

    const embed = new EmbedBuilder().setColor(embedColor).setTitle(text.title);

    if (!status.configured) {
      embed
        .setDescription(text.notConfigured)
        .addFields({ name: text.permissions, value: permissions });
      await context.responses.reply({ embeds: [embed] });
      return;
    }

    const adminPanelChannelId = this.profiles.find(guildId)?.channels.adminPanel ?? null;
    embed.setDescription([
      text.configured,
      text.controlChannel({ channel: status.controlPanelChannelId ? `<#${status.controlPanelChannelId}>` : text.none }),
      adminPanelChannelId ? text.adminPanel({ channel: `<#${adminPanelChannelId}>` }) : text.adminPanelNone,
      ...this.adminPanelHealth.get(guildId).map((issue) => describePanelIssue(text, issue)),
      text.profileFile({ file: status.profileFile ?? text.unknown }),
      permissions,
    ].join("\n"));

    embed.addFields({
      name: text.features,
      value: status.featureStates
        .map((feature) => `${feature.enabled ? "✅" : "⬜"} ${text.feature[feature.name]}`)
        .join("\n"),
      inline: true,
    });

    if (status.access) {
      embed.addFields({
        name: text.roles,
        value: [
          `**${text.role.botAdministrator}:** ${formatRoles(text, status.access.botAdministrator)}`,
          `**${text.role.musicController}:** ${formatRoles(text, status.access.musicController)}`,
          `**${text.role.chatbot}:** ${formatRoles(text, status.access.chatbot)}`,
          `**${text.role.restricted}:** ${formatRoles(text, status.access.restricted)}`,
        ].join("\n"),
        inline: true,
      });
    }

    embed.addFields({ name: text.models, value: this.describeModels(text) });

    if (status.chat) {
      const chat = status.chat;
      const webSearch = chat.webSearchMode === "auto" ? text.auto : text.off;
      const tools = onOff(text, chat.toolCallingEnabled);
      embed.addFields({
        name: text.chat.title,
        value: [
          text.chat.cooldowns({ reply: chat.cooldownSeconds, ambient: chat.ambientCooldownSeconds }),
          chat.disabledTools.length > 0
            ? text.chat.toolsWithDisabled({ webSearch, tools, count: chat.disabledTools.length })
            : text.chat.tools({ webSearch, tools }),
          text.chat.images({ read: onOff(text, chat.imageInputEnabled), make: onOff(text, chat.imageGenerationEnabled) }),
          text.chat.sources({ sources: onOff(text, chat.includeSources), drift: onOff(text, chat.personaDriftEnabled) }),
          text.chat.history({ count: chat.channelHistoryLimit }),
          text.chat.summaries({ once: chat.contextScanChannelIds.length, daily: chat.contextDailyChannelIds.length }),
        ].join("\n"),
      });
    }

    if (status.music) {
      const music = status.music;
      const emptyQueue = music.emptyQueueAction === "disconnect"
        ? text.music.leaveAfter({ duration: formatDuration(text, music.emptyQueueDelayMs) })
        : text.music.stay;
      const graceDuration = formatDuration(text, music.emptyChannelGracePeriodMs);
      const emptyChannel = music.emptyChannelAction === "continue"
        ? text.music.keepPlaying
        : music.emptyChannelAction === "pause"
          ? text.music.pauseAfter({ duration: graceDuration })
          : text.music.leaveAfter({ duration: graceDuration });
      embed.addFields({
        name: text.music.title,
        value: [
          text.music.volume({ volume: music.defaultVolume, max: music.maximumVolume, step: music.volumeButtonStep }),
          text.music.queueEnd({ action: emptyQueue }),
          text.music.everyoneLeaves({ action: emptyChannel }),
          text.music.resume({ value: onOff(text, music.resumeWhenOccupied) }),
          ...(status.panel
            ? [text.music.progressBar({ style: status.panel.progressBar.style, length: status.panel.progressBar.length })]
            : []),
        ].join("\n"),
      });
    }

    embed.setFooter({ text: text.footer });
    await context.responses.reply({ embeds: [embed] });
  }

  private describeModels(text: StatusText): string {
    const { chat, utility, embeddings } = this.models;
    if (!chat) return text.model.none;

    const lines = [`**${text.model.replies}** (${chat.provider}): ${formatModelChain(text, chat.models)}`];
    if (utility) {
      lines.push(`**${text.model.background}** (${utility.provider}): ${formatModelChain(text, utility.models)}`);
    } else if (chat.summaryModels.join() !== chat.models.join()) {
      lines.push(`**${text.model.background}**: ${formatModelChain(text, chat.summaryModels)}`);
    }
    lines.push(embeddings
      ? `**${text.model.memorySearch}** (${embeddings.provider}): \`${embeddings.model}\``
      : `**${text.model.memorySearch}**: ${text.off}`);
    return lines.join("\n");
  }
}
