import { EmbedBuilder, PermissionFlagsBits } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { formatRoleGroupList } from "../../../../application/access/role-group-descriptions.js";
import type { AdminPanelHealth, AdminPanelIssue } from "../../../../application/settings/admin-panel-health.js";
import type { GuildSetupService } from "../../../../application/setup/guild-setup-service.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import type { GuildFeatureName } from "../../../../config/guild-configuration.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

// Instance-wide model wiring (env config, not per-guild) — secrets stripped
// at the wiring site so this command never sees an API key.
export interface ChatModelSummary {
  chat: { provider: string; models: readonly string[]; summaryModels: readonly string[] } | null;
  utility: { provider: string; models: readonly string[] } | null;
  embeddings: { provider: string; model: string } | null;
}

const featureLabels: Record<GuildFeatureName, string> = {
  common: "General commands",
  diagnostics: "Diagnostics",
  music: "Music",
  chatbot: "AI chat",
  birthdays: "Birthdays",
  reminders: "Reminders",
  nsfw: "NSFW",
  linkFix: "Link fixing",
};

const onOff = (enabled: boolean): string => (enabled ? "On" : "Off");

function formatDuration(ms: number): string {
  if (ms <= 0) return "immediately";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function describePanelIssue(issue: AdminPanelIssue): string {
  switch (issue.kind) {
    case "missing-permissions":
      return `⚠️ Admin panel: I'm missing ${issue.permissions.join(", ")} in <#${issue.channelId}>.`;
    case "cannot-lock":
      return `⚠️ Admin panel: I can't stop members posting in <#${issue.channelId}> (needs Manage Permissions).`;
    case "healing-paused":
      return `⚠️ Admin panel: its messages keep getting deleted, so I stopped reposting them. Run \`/settings-access repair-panel\`.`;
    case "channel-deleted":
      return "⚠️ Admin panel: its channel was deleted. Pick a new one with `/settings-access admin-panel`.";
  }
}

function formatModelChain(models: readonly string[]): string {
  const [primary, ...fallbacks] = models;
  const head = `\`${primary ?? "none"}\``;
  return fallbacks.length > 0
    ? `${head}\nFallbacks: ${fallbacks.map((model) => `\`${model}\``).join(" → ")}`
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
    const guildId = context.interaction.guildId;
    if (!guildId) {
      await context.responses.reply("Status is only available in a server.");
      return;
    }

    const status = await this.setupService.status(guildId);
    const embedColor = (this.profiles.find(guildId)?.embedColor ?? "#3B82F6") as `#${string}`;
    const permissions = status.botPermissions.ok
      ? "✅ I have every permission I need."
      : `⚠️ I'm missing: ${status.botPermissions.missing.join(", ")}`;

    const embed = new EmbedBuilder().setColor(embedColor).setTitle("Server status");

    if (!status.configured) {
      embed
        .setDescription("This server isn't set up yet. Run `/setup initialize` to get started.")
        .addFields({ name: "Permissions", value: permissions });
      await context.responses.reply({ embeds: [embed] });
      return;
    }

    const adminPanelChannelId = this.profiles.find(guildId)?.channels.adminPanel ?? null;
    embed.setDescription([
      "✅ This server is set up.",
      `Control channel: ${status.controlPanelChannelId ? `<#${status.controlPanelChannelId}>` : "none"}`,
      `Admin panel: ${adminPanelChannelId ? `<#${adminPanelChannelId}>` : "none — set one with `/settings-access admin-panel`"}`,
      ...this.adminPanelHealth.get(guildId).map(describePanelIssue),
      `Profile file: \`${status.profileFile ?? "unknown"}\``,
      permissions,
    ].join("\n"));

    embed.addFields({
      name: "Features",
      value: status.featureStates
        .map((feature) => `${feature.enabled ? "✅" : "⬜"} ${featureLabels[feature.name]}`)
        .join("\n"),
      inline: true,
    });

    if (status.access) {
      embed.addFields({
        name: "Roles",
        value: [
          `**Bot admins:** ${formatRoleGroupList(status.access.botAdministrator)}`,
          `**Music controllers:** ${formatRoleGroupList(status.access.musicController)}`,
          `**AI chat:** ${formatRoleGroupList(status.access.chatbot)}`,
          `**Restricted:** ${formatRoleGroupList(status.access.restricted)}`,
        ].join("\n"),
        inline: true,
      });
    }

    embed.addFields({ name: "Chat model", value: this.describeModels() });

    if (status.chat) {
      const chat = status.chat;
      const disabledTools = chat.disabledTools.length > 0 ? ` (${chat.disabledTools.length} disabled)` : "";
      embed.addFields({
        name: "AI chat settings",
        value: [
          `Reply cooldown: ${chat.cooldownSeconds}s · Name-mention cooldown: ${chat.ambientCooldownSeconds}s`,
          `Web search: ${chat.webSearchMode === "auto" ? "Auto" : "Off"} · Tools: ${onOff(chat.toolCallingEnabled)}${disabledTools}`,
          `Reads images: ${onOff(chat.imageInputEnabled)} · Makes images: ${onOff(chat.imageGenerationEnabled)}`,
          `Cites sources: ${onOff(chat.includeSources)} · Persona drift: ${onOff(chat.personaDriftEnabled)}`,
          `Reads last ${chat.channelHistoryLimit} messages for context`,
          `Summarized channels: ${chat.contextScanChannelIds.length} one-time, ${chat.contextDailyChannelIds.length} daily`,
        ].join("\n"),
      });
    }

    if (status.music) {
      const music = status.music;
      const emptyQueue = music.emptyQueueAction === "disconnect"
        ? `leave after ${formatDuration(music.emptyQueueDelayMs)}`
        : "stay connected";
      const emptyChannel = music.emptyChannelAction === "continue"
        ? "keep playing"
        : `${music.emptyChannelAction} after ${formatDuration(music.emptyChannelGracePeriodMs)}`;
      embed.addFields({
        name: "Music settings",
        value: [
          `Volume: ${music.defaultVolume}% by default (max ${music.maximumVolume}%, buttons ±${music.volumeButtonStep})`,
          `When the queue ends: ${emptyQueue}`,
          `When everyone leaves: ${emptyChannel}`,
          `Resume when someone returns: ${onOff(music.resumeWhenOccupied)}`,
          ...(status.panel
            ? [`Progress bar: ${status.panel.progressBar.style}, ${status.panel.progressBar.length} wide`]
            : []),
        ].join("\n"),
      });
    }

    embed.setFooter({ text: "Change these with the /settings-… commands." });
    await context.responses.reply({ embeds: [embed] });
  }

  private describeModels(): string {
    const { chat, utility, embeddings } = this.models;
    if (!chat) return "No chat model configured — AI chat is unavailable.";

    const lines = [`**Replies** (${chat.provider}): ${formatModelChain(chat.models)}`];
    if (utility) {
      lines.push(`**Background tasks** (${utility.provider}): ${formatModelChain(utility.models)}`);
    } else if (chat.summaryModels.join() !== chat.models.join()) {
      lines.push(`**Background tasks**: ${formatModelChain(chat.summaryModels)}`);
    }
    lines.push(embeddings
      ? `**Memory search** (${embeddings.provider}): \`${embeddings.model}\``
      : "**Memory search**: off");
    return lines.join("\n");
  }
}
