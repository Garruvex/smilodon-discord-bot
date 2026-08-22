import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { CommandMetadata, SubcommandGroupMetadata } from "../../../../application/commands/command-metadata.js";
import type { ChatToolRegistry } from "../../../../application/chat/tools/chat-tool-registry.js";
import type { UpdateGuildConfigurationInput, GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import { RoleMatchMode, publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import type { GuildAssetStore } from "../../../../application/assets/guild-asset-store.js";
import type { ControlChannelService } from "../../../../application/control-panel/control-channel-service.js";
import type { ApplicationEmojiCatalog } from "../../application-emoji-catalog.js";
import type { AuditLogService } from "../../../../application/audit/audit-log-service.js";
import type { PersonaDriftStore } from "../../../../application/chat/persona-drift-store.js";
import type { ChannelSummaryCheckpointStore } from "../../../../application/context/channel-summary-checkpoint-store.js";
import {
  settingDefinitionsByName,
  settingGroups,
  type FieldChange,
  type MutationSettingDefinition,
  type SettingDeps,
} from "./settings/index.js";
import { renderProgressPreview } from "./settings/settings-support.js";

function buildDefinition(): CommandMetadata {
  const subcommandGroups: SubcommandGroupMetadata[] = settingGroups.map((group) => ({
    name: group.name,
    description: group.description,
    subcommands: group.settings.map((setting) => ({
      name: setting.name,
      description: setting.description,
      options: setting.configureOptions?.() ?? [],
    })),
  }));
  return {
    name: "settings",
    description: "Updates this server's bot configuration.",
    subcommandGroups,
  };
}

// The slash-command definition, per-subcommand dispatch, and confirmation
// text are all derived from settingGroups (./settings/index.ts) — to add or
// remove a /settings <group> <setting> subcommand, add or remove one file
// there. What remains here is genuinely cross-cutting: control-panel sync,
// asset cleanup, audit logging, and the generic field-diff confirmation
// renderer.
export class SettingsCommand implements BotCommand {
  private controlChannelService: ControlChannelService | null = null;
  private readonly deps: SettingDeps;

  public readonly definition = buildDefinition();

  public readonly module = CommandModule.Common;
  public readonly access = {
    ...publicAccessPolicy,
    roles: { match: RoleMatchMode.Any, requiredGroups: ["botAdministrator" as const] },
  };

  public constructor(
    private readonly profiles: GuildConfigurationProvider,
    private readonly assets: GuildAssetStore,
    private readonly applicationEmojiCatalog: ApplicationEmojiCatalog,
    private readonly auditLogService?: AuditLogService,
    personaDriftStore?: PersonaDriftStore,
    channelSummaryCheckpointStore?: ChannelSummaryCheckpointStore,
    channelSummaryProviderAvailable = false,
  ) {
    this.deps = { assets, applicationEmojiCatalog, channelSummaryProviderAvailable };
    if (auditLogService) this.deps.auditLogService = auditLogService;
    if (personaDriftStore) this.deps.personaDriftStore = personaDriftStore;
    if (channelSummaryCheckpointStore) this.deps.channelSummaryCheckpointStore = channelSummaryCheckpointStore;
  }

  public bindControlChannelService(service: ControlChannelService): void {
    this.controlChannelService = service;
  }

  // See SettingDeps.chatToolRegistry — called once dependencies.ts has
  // derived the registry from every registered command's toolBinding.
  public bindChatToolRegistry(chatToolRegistry: ChatToolRegistry): void {
    this.deps.chatToolRegistry = chatToolRegistry;
  }

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.guildId) return;
    await context.responses.defer();
    const previousProfile = this.profiles.require(context.interaction.guildId);
    const subcommand = context.interaction.options.getSubcommand(true);
    const setting = settingDefinitionsByName.get(subcommand);
    if (!setting) return;

    if (setting.kind === "readOnly") {
      await context.responses.edit(await setting.run(context, this.deps, previousProfile));
      return;
    }

    const input: UpdateGuildConfigurationInput = {};
    const result = await setting.handle(context, this.deps, previousProfile, input);
    if (!result.ok) {
      await context.responses.edit(result.message);
      return;
    }
    if (Object.keys(input).length === 0) {
      await context.responses.edit("Provide at least one setting to change.");
      return;
    }

    const updatedProfile = await this.profiles.update(context.interaction.guildId, input);
    await this.syncControlPanel(context.interaction.guildId, subcommand, input, updatedProfile);
    if (
      previousProfile.idleImageAsset &&
      previousProfile.idleImageAsset !== updatedProfile.idleImageAsset
    ) {
      await this.assets.removeIdleImage(previousProfile.idleImageAsset);
    }
    if (
      previousProfile.chat.personalityAsset &&
      previousProfile.chat.personalityAsset !== updatedProfile.chat.personalityAsset
    ) {
      await this.assets.removePersonality(previousProfile.chat.personalityAsset);
    }
    if (
      previousProfile.chat.examplesAsset &&
      previousProfile.chat.examplesAsset !== updatedProfile.chat.examplesAsset
    ) {
      await this.assets.removeExamples(previousProfile.chat.examplesAsset);
    }
    const description = this.describeUpdate(setting, previousProfile, updatedProfile, input, result.extraLines ?? []);
    await this.auditLogService?.log(
      context.interaction.guildId,
      context.interaction.user.id,
      `**/settings ${subcommand}**\n${description}`,
    );
    await context.responses.edit(
      input.progressBar
        ? `${description}\n\nPreview:\n${renderProgressPreview(input.progressBar, this.applicationEmojiCatalog)}`
        : description,
    );
  }

  private async syncControlPanel(
    guildId: string,
    subcommand: string,
    input: UpdateGuildConfigurationInput,
    profile: GuildConfiguration,
  ): Promise<void> {
    if (!this.controlChannelService || !profile.features.music || !profile.channels.controlPanel) {
      return;
    }

    if (input.controlPanelChannelId) {
      await this.controlChannelService.ensureGuildPanel(guildId);
      return;
    }

    if (
      subcommand === "panel" &&
      (
        input.idleImageUrl !== undefined ||
        input.idleImageAsset !== undefined ||
        input.progressBar !== undefined
      )
    ) {
      await this.controlChannelService.refreshPanel(guildId, {
        forceIdleImage:
          input.idleImageAsset !== undefined ||
          (input.idleImageUrl === null && input.idleImageAsset === null),
      });
    }
  }

  private describeUpdate(
    setting: MutationSettingDefinition,
    previousProfile: GuildConfiguration,
    updatedProfile: GuildConfiguration,
    input: UpdateGuildConfigurationInput,
    handlerExtraLines: readonly string[],
  ): string {
    const custom = setting.describe?.(previousProfile, updatedProfile, input) ?? null;
    if (custom !== null) return handlerExtraLines.length > 0 ? [custom, ...handlerExtraLines].join("\n") : custom;
    const diffLines = [
      ...this.describeFieldChanges(previousProfile, updatedProfile, setting.fieldChanges ?? []),
      ...(setting.extraLines?.(previousProfile, updatedProfile) ?? []),
      ...handlerExtraLines,
    ];
    if (diffLines.length === 0) return "Server settings updated.";
    const lines = ["Server settings updated.", ...diffLines];
    if (
      diffLines.some((line) => line.startsWith("Chatbot")) &&
      !updatedProfile.features.chatbot
    ) {
      lines.push("Note: the chatbot feature is currently disabled, so this has no effect until it's enabled.");
    }
    return lines.join("\n");
  }

  private describeFieldChanges(
    previous: GuildConfiguration,
    updated: GuildConfiguration,
    fields: readonly FieldChange[],
  ): string[] {
    return fields
      .filter((field) => field.read(previous) !== field.read(updated))
      .map((field) => `${field.label}: ${String(field.read(previous))} → ${String(field.read(updated))}`);
  }
}
