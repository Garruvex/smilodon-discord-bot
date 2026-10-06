import type { CampaignLobbyService } from "../../../application/campaign/campaign-lobby-service.js";
import type { GuildCampaignSettings } from "../../../application/campaign/ports/campaign-record.js";
import type { CampaignUnitOfWork } from "../../../application/campaign/ports/campaign-store.js";
import type { CampaignSetupService, GuildSetupResult } from "./campaign-setup-service.js";

// What the settings panel shows and changes about D&D on one server. The
// hub channel, category and DnD Admin role live with the campaign data (they
// are made and repaired by setup), so the panel reaches them through here
// rather than through the guild configuration.
export interface CampaignServerStatus {
  readonly setUp: boolean;
  readonly categoryId: string | null;
  readonly hubChannelId: string | null;
  readonly adminRoleId: string | null;
  // Games that are not finished.
  readonly liveGames: number;
  readonly modelConfigured: boolean;
}

export interface CampaignSettingsAccessOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly lobby: CampaignLobbyService;
  readonly setup: CampaignSetupService;
  readonly modelConfigured: boolean;
}

export class CampaignSettingsAccess {
  public constructor(private readonly options: CampaignSettingsAccessOptions) {}

  public async status(guildId: string): Promise<CampaignServerStatus> {
    const settings = await this.settings(guildId);
    const games = await this.options.lobby.list(guildId);
    return {
      setUp: settings !== null && settings.categoryId !== null && settings.hubChannelId !== null,
      categoryId: settings?.categoryId ?? null,
      hubChannelId: settings?.hubChannelId ?? null,
      adminRoleId: settings?.adminRoleId ?? null,
      liveGames: games.filter(({ record }) => record.lifecycle !== "archived").length,
      modelConfigured: this.options.modelConfigured,
    };
  }

  // Sets the server up, moves the hub to `channelId`, or (null) repairs what is
  // there: the category, hub channel, DnD Admin role and every card.
  public setUp(guildId: string, channelId: string | null): Promise<GuildSetupResult> {
    return this.options.setup.setupGuild(guildId, channelId);
  }

  // Hands the DnD Admin powers to another role. False before the server is set up.
  public async setAdminRole(guildId: string, roleId: string): Promise<boolean> {
    const settings = await this.settings(guildId);
    if (settings === null) return false;
    await this.options.unitOfWork.transaction((tx) => tx.saveGuildSettings({ ...settings, adminRoleId: roleId }));
    return true;
  }

  private settings(guildId: string): Promise<GuildCampaignSettings | null> {
    return this.options.unitOfWork.transaction(async (tx) => (await tx.loadGuildSettings(guildId)) ?? null);
  }
}
