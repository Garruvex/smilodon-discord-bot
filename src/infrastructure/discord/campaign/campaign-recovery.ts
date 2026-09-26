import type { CampaignIssues } from "../../../application/campaign/campaign-issues.js";
import type { CampaignLobbyService } from "../../../application/campaign/campaign-lobby-service.js";
import type { RuntimeLogger } from "../../../application/campaign/campaign-runtime.js";
import type { CampaignUnitOfWork } from "../../../application/campaign/ports/campaign-store.js";
import type { CampaignCardService } from "./campaign-card-service.js";
import type { CampaignSetupService } from "./campaign-setup-service.js";

export interface CampaignRecoveryOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly lobby: Pick<CampaignLobbyService, "findByChannel">;
  readonly setup: CampaignSetupService;
  readonly cards: CampaignCardService;
  readonly issues: CampaignIssues;
  readonly logger: RuntimeLogger;
  readonly now?: () => number;
}

// A game's channel is made again at most this often before the organizer has
// to decide (someone may be deleting it on purpose).
const recoveriesPerWindow = 3;
const windowMs = 60 * 60 * 1000;

// Puts things back when Discord takes a place away (plan §10). A deleted hub
// channel, game channel or Table Talk thread is made again and its cards drawn
// into it. Recovery stays controlled: a finished game is left alone, a
// missing permission or a channel that keeps being deleted becomes an issue
// for the organizer instead of a loop of failing or unwanted creates.
export class CampaignRecovery {
  private readonly recoveries = new Map<string, number[]>();

  public constructor(private readonly options: CampaignRecoveryOptions) {}

  public async channelDeleted(guildId: string, channelId: string): Promise<void> {
    const { unitOfWork, lobby, setup, cards, issues, logger } = this.options;
    const settings = await unitOfWork.transaction((tx) => tx.loadGuildSettings(guildId));
    if (settings?.hubChannelId === channelId) {
      const result = await setup.setupGuild(guildId, null);
      if (result.kind === "missingPermissions") logger.warn({ guildId, missing: result.missing }, "The hub channel could not be made again");
      return;
    }
    const found = await lobby.findByChannel(guildId, [channelId]);
    if (found === undefined || found.record.lifecycle === "archived") return;
    const { key } = found.record;
    if (!this.allowed(key.campaignId)) {
      await issues.raise(key, "channelMissing", "recreated too often");
      return;
    }
    const result = await setup.provision(key);
    switch (result.kind) {
      case "ok":
        await cards.sync(key, true);
        return;
      case "missingPermissions":
        await issues.raise(key, "permissions", result.missing.join(", "));
        return;
      case "failed":
        await issues.raise(key, "channelMissing", result.step);
        return;
      default:
        return;
    }
  }

  // Counts this recovery against the game's hour, false when it is used up.
  private allowed(campaignId: string): boolean {
    const now = (this.options.now ?? Date.now)();
    const recent = (this.recoveries.get(campaignId) ?? []).filter((at) => now - at < windowMs);
    if (recent.length >= recoveriesPerWindow) {
      this.recoveries.set(campaignId, recent);
      return false;
    }
    this.recoveries.set(campaignId, [...recent, now]);
    return true;
  }
}
