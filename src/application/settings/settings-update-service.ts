import type { GuildAssetStore } from "../assets/guild-asset-store.js";
import type { AuditLogService } from "../audit/audit-log-service.js";
import type { ControlChannelService } from "../control-panel/control-channel-service.js";
import type { GuildConfiguration } from "../../config/guild-configuration.js";
import type {
  GuildConfigurationProvider,
  UpdateGuildConfigurationInput,
} from "../../config/guild-configuration-provider.js";

export interface SettingsChange {
  guildId: string;
  actorUserId: string;
  // First line of the audit-log entry, e.g. "**/settings-music volume**".
  auditHeading: string;
  input: UpdateGuildConfigurationInput;
  // Builds the human-readable summary shown to the actor and written to the
  // audit log. Runs after the write, so it sees the stored result.
  describe(previous: GuildConfiguration, updated: GuildConfiguration): string;
}

export interface AppliedSettingsChange {
  guildId: string;
  actorUserId: string;
  input: UpdateGuildConfigurationInput;
  previous: GuildConfiguration;
  updated: GuildConfiguration;
  description: string;
}

// Called after every successful write, whichever surface made it. A listener
// handles (and logs) its own failures — a broken redraw must never turn a
// saved change into an error reply.
export type SettingsChangeListener = (change: AppliedSettingsChange) => Promise<void>;

// Everything that follows a settings write, shared by the /settings-* slash
// commands and the admin panel so neither can drift from the other: persist,
// refresh the music panel, drop replaced assets, audit, notify listeners.
export class SettingsUpdateService {
  private controlChannelService: ControlChannelService | null = null;
  private readonly listeners: SettingsChangeListener[] = [];

  public constructor(
    private readonly profiles: GuildConfigurationProvider,
    private readonly assets: GuildAssetStore,
    private readonly auditLogService?: AuditLogService,
  ) {}

  public bindControlChannelService(service: ControlChannelService): void {
    this.controlChannelService = service;
  }

  public addListener(listener: SettingsChangeListener): void {
    this.listeners.push(listener);
  }

  public async apply(change: SettingsChange): Promise<AppliedSettingsChange> {
    const { guildId, input } = change;
    const previous = this.profiles.require(guildId);
    const updated = await this.profiles.update(guildId, input);
    await this.syncControlPanel(guildId, input, updated);
    await this.removeReplacedAssets(previous, updated);

    const description = change.describe(previous, updated);
    await this.auditLogService?.log(guildId, change.actorUserId, `${change.auditHeading}\n${description}`);

    const applied: AppliedSettingsChange = {
      guildId,
      actorUserId: change.actorUserId,
      input,
      previous,
      updated,
      description,
    };
    for (const listener of this.listeners) await listener(applied);
    return applied;
  }

  private async syncControlPanel(
    guildId: string,
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

    if (input.language !== undefined) {
      await this.controlChannelService.refreshPanel(guildId, { immediate: true });
      return;
    }

    if (
      input.idleImageUrl !== undefined ||
      input.idleImageAsset !== undefined ||
      input.progressBar !== undefined ||
      input.progressBarStyle !== undefined ||
      input.progressBarLength !== undefined
    ) {
      await this.controlChannelService.refreshPanel(guildId, {
        forceIdleImage:
          input.idleImageAsset !== undefined ||
          (input.idleImageUrl === null && input.idleImageAsset === null),
        immediate: true,
      });
    }
  }

  private async removeReplacedAssets(previous: GuildConfiguration, updated: GuildConfiguration): Promise<void> {
    if (previous.idleImageAsset && previous.idleImageAsset !== updated.idleImageAsset) {
      await this.assets.removeIdleImage(previous.idleImageAsset);
    }
    if (previous.chat.personalityAsset && previous.chat.personalityAsset !== updated.chat.personalityAsset) {
      await this.assets.removePersonality(previous.chat.personalityAsset);
    }
    if (previous.chat.examplesAsset && previous.chat.examplesAsset !== updated.chat.examplesAsset) {
      await this.assets.removeExamples(previous.chat.examplesAsset);
    }
    if (
      previous.chat.selfReferenceImageAsset &&
      previous.chat.selfReferenceImageAsset !== updated.chat.selfReferenceImageAsset
    ) {
      await this.assets.removeSelfReferenceImage(previous.chat.selfReferenceImageAsset);
    }
  }
}
