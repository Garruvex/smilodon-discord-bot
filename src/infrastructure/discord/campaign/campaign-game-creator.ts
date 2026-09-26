import type { CampaignLobbyService, ServiceRefusal } from "../../../application/campaign/campaign-lobby-service.js";
import type { CampaignRecord, PendingResource } from "../../../application/campaign/ports/campaign-record.js";
import type { CampaignLanguage } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { Texts } from "../../../application/i18n/texts.js";
import type { CampaignSetupService } from "./campaign-setup-service.js";
import { refusalText } from "./refusal-text.js";

export interface NewGame {
  readonly guildId: string;
  readonly organizerId: string;
  readonly name: string;
  readonly language: CampaignLanguage;
  readonly pacing: "live" | "playByPost";
  readonly players: number;
}

export type CreateGameResult =
  | { readonly kind: "created"; readonly record: CampaignRecord }
  | { readonly kind: "refused"; readonly reason: ServiceRefusal }
  | { readonly kind: "noModel" }
  | { readonly kind: "notSetup" }
  | { readonly kind: "notFound" }
  | { readonly kind: "missingPermissions"; readonly missing: readonly string[] }
  | { readonly kind: "failed"; readonly name: string; readonly step: PendingResource["kind"] };

// Creating a game: its record and lobby, then its channels. One path for the
// /dnd new command and the hub's Create game wizard.
export class CampaignGameCreator {
  public constructor(
    private readonly options: {
      readonly lobby: CampaignLobbyService;
      readonly setup: CampaignSetupService;
      // The adventure a new game starts from (the bundled default for now).
      readonly defaultAdventureId: string;
      // False when no CAMPAIGN_MODEL is set: a game could not be run, so none is started.
      readonly modelConfigured: boolean;
    },
  ) {}

  public get modelConfigured(): boolean {
    return this.options.modelConfigured;
  }

  public async create(game: NewGame): Promise<CreateGameResult> {
    if (!this.options.modelConfigured) return { kind: "noModel" };
    const created = await this.options.lobby.create({
      guildId: game.guildId,
      organizerId: game.organizerId,
      name: game.name,
      language: game.language,
      adventureId: this.options.defaultAdventureId,
      pacing: { preset: game.pacing },
      maxPlayers: game.players,
      // No combat controls on Discord yet: fights play themselves on cautious autopilot.
      houseRules: { "combat-mode": "autopilot" },
    });
    if (created.kind === "refused") return { kind: "refused", reason: created.reason };
    const provisioned = await this.options.setup.provision(created.value.key);
    switch (provisioned.kind) {
      case "ok":
        return { kind: "created", record: provisioned.record };
      case "failed":
        return { kind: "failed", name: created.value.name, step: provisioned.step };
      case "missingPermissions":
        return provisioned;
      case "notSetup":
        return provisioned;
      case "notFound":
        return provisioned;
    }
  }
}

// What the person who asked is told, in the language they used.
export function createGameText(result: CreateGameResult, text: Texts): string {
  const t = text.campaign.cmd;
  switch (result.kind) {
    case "created":
      return t.created({ name: result.record.name, party: result.record.channels.partyChannelId ?? "", adventure: result.record.channels.adventureChannelId ?? "" });
    case "refused":
      return refusalText(text, result.reason);
    case "noModel":
      return t.noModel;
    case "notSetup":
      return t.notSetup;
    case "notFound":
      return text.campaign.refusal.notFound;
    case "missingPermissions":
      return t.setupMissing({ permissions: result.missing.join(", ") });
    case "failed":
      return t.createdNoChannels({ name: result.name, step: result.step });
  }
}
