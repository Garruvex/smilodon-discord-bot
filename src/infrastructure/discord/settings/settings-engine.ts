import type { InteractionEditReplyOptions } from "discord.js";

import type { GuildAssetStore } from "../../../application/assets/guild-asset-store.js";
import type { AuditLogService } from "../../../application/audit/audit-log-service.js";
import type { PersonaDriftStore } from "../../../application/chat/persona-drift-store.js";
import type { ChatToolRegistry } from "../../../application/chat/tools/chat-tool-registry.js";
import type { ChannelSummaryCheckpointStore } from "../../../application/context/channel-summary-checkpoint-store.js";
import type { ControlChannelService } from "../../../application/control-panel/control-channel-service.js";
import {
  SettingsUpdateService,
  type SettingsChangeListener,
} from "../../../application/settings/settings-update-service.js";
import type { GuildConfiguration } from "../../../config/guild-configuration.js";
import type {
  GuildConfigurationProvider,
  UpdateGuildConfigurationInput,
} from "../../../config/guild-configuration-provider.js";
import { RoleMatchMode, publicAccessPolicy } from "../../../domain/access/access-policy.js";
import type { ApplicationEmojiCatalog } from "../application-emoji-catalog.js";
import {
  settingDefinitionsByName,
  type FieldChange,
  type MutationSettingDefinition,
  type SettingDefinition,
  type SettingDeps,
  type SettingRequest,
} from "./definitions/index.js";

// Who may change settings, on every surface: the /settings-* commands and the
// admin panel's controls both use this one policy.
export const settingsAccessPolicy = {
  ...publicAccessPolicy,
  roles: { match: RoleMatchMode.Any, requiredGroups: ["botAdministrator" as const] },
};

// Which surface a change came from — only used to label the audit entry.
export type SettingSource =
  | { kind: "slash"; commandName: string }
  | { kind: "panel"; section: string };

export type SettingRunResult =
  // A read-only setting's output (access summary, audit log, tools list…).
  | { kind: "report"; reply: string | InteractionEditReplyOptions }
  // The setting refused the values; nothing was written.
  | { kind: "rejected"; message: string }
  // The values didn't ask for any change; nothing was written.
  | { kind: "empty" }
  | {
    kind: "updated";
    description: string;
    input: UpdateGuildConfigurationInput;
    previous: GuildConfiguration;
    updated: GuildConfiguration;
  };

export interface SettingsEngineOptions {
  profiles: GuildConfigurationProvider;
  assets: GuildAssetStore;
  applicationEmojiCatalog: ApplicationEmojiCatalog;
  auditLogService?: AuditLogService;
  // Absent when no chat provider is configured — see SettingDeps.
  personaDriftStore?: PersonaDriftStore;
  channelSummaryCheckpointStore?: ChannelSummaryCheckpointStore;
  channelSummaryProviderAvailable?: boolean;
}

// The one place a setting runs. Every surface — the /settings-* slash
// commands, the admin panel — turns its interaction into a SettingRequest
// and calls run(); validation, the write, the confirmation text, the audit
// entry and every follow-up effect come from here, so the surfaces can't
// disagree about what a change does.
export class SettingsEngine {
  private readonly deps: SettingDeps;
  private readonly updater: SettingsUpdateService;

  public constructor(private readonly options: SettingsEngineOptions) {
    this.updater = new SettingsUpdateService(options.profiles, options.assets, options.auditLogService);
    this.deps = {
      assets: options.assets,
      applicationEmojiCatalog: options.applicationEmojiCatalog,
      channelSummaryProviderAvailable: options.channelSummaryProviderAvailable ?? false,
    };
    if (options.auditLogService) this.deps.auditLogService = options.auditLogService;
    if (options.personaDriftStore) this.deps.personaDriftStore = options.personaDriftStore;
    if (options.channelSummaryCheckpointStore) {
      this.deps.channelSummaryCheckpointStore = options.channelSummaryCheckpointStore;
    }
  }

  public bindControlChannelService(service: ControlChannelService): void {
    this.updater.bindControlChannelService(service);
  }

  // See SettingDeps.chatToolRegistry — called once dependencies.ts has
  // derived the registry from every registered command's toolBinding.
  public bindChatToolRegistry(chatToolRegistry: ChatToolRegistry): void {
    this.deps.chatToolRegistry = chatToolRegistry;
  }

  // Runs after every successful write, from any surface.
  public addChangeListener(listener: SettingsChangeListener): void {
    this.updater.addListener(listener);
  }

  public find(settingName: string): SettingDefinition | undefined {
    return settingDefinitionsByName.get(settingName);
  }

  public async run(
    setting: SettingDefinition,
    request: SettingRequest,
    source: SettingSource,
  ): Promise<SettingRunResult> {
    const previousProfile = this.options.profiles.require(request.guildId);

    if (setting.kind === "readOnly") {
      return { kind: "report", reply: await setting.run(request, this.deps, previousProfile) };
    }

    const input: UpdateGuildConfigurationInput = {};
    const result = await setting.handle(request, this.deps, previousProfile, input);
    if (!result.ok) return { kind: "rejected", message: result.message };
    if (Object.keys(input).length === 0) return { kind: "empty" };

    const applied = await this.updater.apply({
      guildId: request.guildId,
      actorUserId: request.actorUserId,
      auditHeading: auditHeading(setting.name, source),
      input,
      describe: (previous, updated) =>
        describeUpdate(setting, previous, updated, input, result.extraLines ?? []),
    });
    return {
      kind: "updated",
      description: applied.description,
      input,
      previous: applied.previous,
      updated: applied.updated,
    };
  }
}

function auditHeading(settingName: string, source: SettingSource): string {
  return source.kind === "slash"
    ? `**/${source.commandName} ${settingName}**`
    : `**Admin panel · ${source.section} › ${settingName}**`;
}

function describeUpdate(
  setting: MutationSettingDefinition,
  previousProfile: GuildConfiguration,
  updatedProfile: GuildConfiguration,
  input: UpdateGuildConfigurationInput,
  handlerExtraLines: readonly string[],
): string {
  const custom = setting.describe?.(previousProfile, updatedProfile, input) ?? null;
  if (custom !== null) return handlerExtraLines.length > 0 ? [custom, ...handlerExtraLines].join("\n") : custom;
  const diffLines = [
    ...describeFieldChanges(previousProfile, updatedProfile, setting.fieldChanges ?? []),
    ...(setting.extraLines?.(previousProfile, updatedProfile) ?? []),
    ...handlerExtraLines,
  ];
  if (diffLines.length === 0) return "No changes — those settings already match the requested values.";
  const lines = ["Server settings updated.", ...diffLines];
  if (
    diffLines.some((line) => line.startsWith("Chatbot")) &&
    !updatedProfile.features.chatbot
  ) {
    lines.push("Note: the chatbot feature is currently disabled, so this has no effect until it's enabled.");
  }
  return lines.join("\n");
}

function describeFieldChanges(
  previous: GuildConfiguration,
  updated: GuildConfiguration,
  fields: readonly FieldChange[],
): string[] {
  return fields
    .filter((field) => field.read(previous) !== field.read(updated))
    .map((field) => `${field.label}: ${String(field.read(previous))} → ${String(field.read(updated))}`);
}
