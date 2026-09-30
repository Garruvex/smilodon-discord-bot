import type { CampaignLobbyService, ServiceRefusal } from "../../../application/campaign/campaign-lobby-service.js";
import type { CampaignRecord, CampaignVisibility, PendingResource } from "../../../application/campaign/ports/campaign-record.js";
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
  // Where a fight's gold goes (the "loot-gold" house rule); pooled when absent.
  readonly lootGold?: "pooled" | "split";
  // Who can see the game's channels once it starts; open when absent.
  readonly visibility?: CampaignVisibility;
  // An adventure the server added; the bundled one when absent.
  readonly adventureId?: string;
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
      // The adventures a server may start from (its own and the bundled one).
      readonly adventures?: { listForGuild(guildId: string): readonly { readonly id: string; readonly languages?: readonly CampaignLanguage[]; readonly titles?: Readonly<Partial<Record<CampaignLanguage, string>>> }[] };
    },
  ) {}

  public get modelConfigured(): boolean {
    return this.options.modelConfigured;
  }

  // The adventure a person named (its title or ID, or part of the title) among those this server can start in this language,
  // for /dnd new. None named is the bundled one; no match lists what there is.
  public findAdventure(guildId: string, language: CampaignLanguage, query: string | null): { readonly kind: "found"; readonly adventureId: string | undefined } | { readonly kind: "none"; readonly available: readonly string[] } | { readonly kind: "ambiguous"; readonly matches: readonly string[] } {
    if (query === null || query.trim() === "") return { kind: "found", adventureId: undefined };
    const wanted = query.trim().toLowerCase();
    const offered = (this.options.adventures?.listForGuild(guildId) ?? []).filter((entry) => entry.languages === undefined || entry.languages.includes(language));
    const titleOf = (entry: (typeof offered)[number]): string => entry.titles?.[language] ?? entry.titles?.en ?? entry.id;
    const exact = offered.filter((entry) => entry.id.toLowerCase() === wanted || titleOf(entry).toLowerCase() === wanted);
    const matches = exact.length > 0 ? exact : offered.filter((entry) => titleOf(entry).toLowerCase().includes(wanted));
    if (matches.length === 1 && matches[0] !== undefined) return { kind: "found", adventureId: matches[0].id === this.options.defaultAdventureId ? undefined : matches[0].id };
    return matches.length === 0 ? { kind: "none", available: offered.map(titleOf) } : { kind: "ambiguous", matches: matches.map(titleOf) };
  }

  public async create(game: NewGame): Promise<CreateGameResult> {
    if (!this.options.modelConfigured) return { kind: "noModel" };
    const adventureId = game.adventureId ?? this.options.defaultAdventureId;
    // Only the bundled adventure, or one this server itself approved.
    const allowed = adventureId === this.options.defaultAdventureId || this.options.adventures?.listForGuild(game.guildId).some((entry) => entry.id === adventureId && (entry.languages === undefined || entry.languages.includes(game.language))) === true;
    if (!allowed) return { kind: "refused", reason: "unknownAdventure" };
    const created = await this.options.lobby.create({
      guildId: game.guildId,
      organizerId: game.organizerId,
      name: game.name,
      language: game.language,
      adventureId,
      pacing: { preset: game.pacing },
      maxPlayers: game.players,
      visibility: game.visibility ?? "open",
      // Players take their heroes' turns in a fight; an away hero is played on cautious autopilot.
      houseRules: { "combat-mode": "players", "loot-gold": game.lootGold ?? "pooled" },
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
      return t.created({ name: result.record.name, party: result.record.channels.partyPostId ?? "", adventure: result.record.channels.adventurePostId ?? "" });
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
