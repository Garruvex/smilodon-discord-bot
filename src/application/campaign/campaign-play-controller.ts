import type { CampaignCommand } from "../../domain/campaign/commands/campaign-command.js";
import { isFallen } from "../../domain/campaign/state/campaign-state.js";
import type { AdventureLibrary } from "./ports/adventure-library.js";
import type { CharacterId, UserId } from "../../domain/campaign/core/ids.js";
import type { RejectionCode } from "../../domain/campaign/engine/rejection.js";
import type { CampaignState } from "../../domain/campaign/state/campaign-state.js";
import type { CampaignCommandBus } from "./campaign-command-bus.js";
import type { CardRefresher } from "./ports/card-refresher.js";
import type { CampaignKey, CampaignUnitOfWork } from "./ports/campaign-store.js";

// Why a control did nothing. Engine rejections keep their code; the rest are
// the controller's own. The Discord layer turns each into a private message.
export type PlayRefusal = RejectionCode | "notFound" | "notActive" | "noHero" | "noPendingRoll";

export type PlayResult = { readonly kind: "ok" } | { readonly kind: "refused"; readonly reason: PlayRefusal };

// What a Discord button or form does to a running campaign: it finds the
// clicker's hero, sends one command through the bus (the single write path),
// and asks for the cards to be redrawn. It grants nothing itself; the engine
// checks membership, ownership, organizer rights, and round state.
export class CampaignPlayController {
  public constructor(
    private readonly options: {
      readonly unitOfWork: CampaignUnitOfWork;
      readonly bus: CampaignCommandBus;
      readonly refresher: CardRefresher;
      readonly adventures: AdventureLibrary;
    },
  ) {}

  // The heroes a player whose hero fell can take instead: the adventure's
  // presets that no living hero already is. Empty when their hero is alive.
  public async replacementOptions(key: CampaignKey, userId: UserId): Promise<readonly { readonly id: string; readonly name: string; readonly className: string }[]> {
    const loaded = await this.options.unitOfWork.transaction(async (tx) => ({ record: await tx.loadRecord(key), stored: await tx.loadCampaign(key) }));
    if (loaded.record === undefined || loaded.stored === undefined) return [];
    const { state } = loaded.stored;
    const current = state.members[userId]?.characterId ?? null;
    if (current === null || !isFallen(state, current)) return [];
    const heroes = this.options.adventures.document(loaded.record.record.adventure.adventureId, loaded.record.record.language)?.heroes ?? [];
    const living = Object.values(state.characters).filter((sheet) => !isFallen(state, sheet.id));
    return heroes
      .filter((hero) => !living.some((sheet) => baseHeroId(sheet.id) === hero.id))
      .map((hero) => ({ id: hero.id, name: hero.name, className: hero.class }));
  }

  // A player whose hero fell joins a new one: a fresh copy of a preset at the
  // party's level, with starting gear and none of the old hero's loot.
  public async joinHero(key: CampaignKey, userId: UserId, presetId: string, interactionId: string): Promise<PlayResult> {
    const options = await this.replacementOptions(key, userId);
    if (!options.some((option) => option.id === presetId)) return { kind: "refused", reason: "heroNotReplaceable" };
    const loaded = await this.options.unitOfWork.transaction(async (tx) => ({ record: await tx.loadRecord(key), stored: await tx.loadCampaign(key) }));
    if (loaded.record === undefined || loaded.stored === undefined) return { kind: "refused", reason: "notFound" };
    const document = this.options.adventures.document(loaded.record.record.adventure.adventureId, loaded.record.record.language);
    const preset = document?.heroes.find((hero) => hero.id === presetId);
    if (preset === undefined) return { kind: "refused", reason: "invalidHero" };
    const used = Object.values(loaded.stored.state.characters).filter((sheet) => baseHeroId(sheet.id) === presetId).length;
    const { class: className, ...sheet } = preset;
    const outcome = await this.options.bus.execute(
      key,
      { kind: "joinHero", sheet: { ...sheet, className, id: `${presetId}-${used + 1}`, ownerUserId: userId, name: used === 0 ? preset.name : `${preset.name} ${roman(used + 1)}` } },
      { commandId: `dnd:${interactionId}`, actor: { kind: "user", userId } },
    );
    if (outcome.kind === "notFound") return { kind: "refused", reason: "notFound" };
    if (outcome.kind === "rejected") return { kind: "refused", reason: outcome.rejection.code };
    this.options.refresher.refresh(key);
    return { kind: "ok" };
  }

  public submitAction(key: CampaignKey, userId: UserId, text: string, interactionId: string): Promise<PlayResult> {
    return this.asHero(key, userId, interactionId, (characterId) => ({ kind: "submitAction", characterId, text }));
  }

  public pass(key: CampaignKey, userId: UserId, interactionId: string): Promise<PlayResult> {
    return this.asHero(key, userId, interactionId, (characterId) => ({ kind: "pass", characterId }));
  }

  // The clicker's own pending check: Roll is a shared button, so it finds whose it is.
  public roll(key: CampaignKey, userId: UserId, interactionId: string): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, (state) => {
      const heroId = state.members[userId]?.characterId;
      if (heroId === null || heroId === undefined) return "noHero";
      const check = Object.values(state.checks).find((candidate) => candidate.characterId === heroId && candidate.status === "pending");
      return check === undefined ? "noPendingRoll" : { kind: "requestRoll", checkId: check.id };
    });
  }

  public away(key: CampaignKey, userId: UserId, interactionId: string): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, () => ({ kind: "markAway", userId }));
  }

  public back(key: CampaignKey, userId: UserId, interactionId: string): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, () => ({ kind: "markReturned", userId }));
  }

  public continue(key: CampaignKey, userId: UserId, interactionId: string): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, () => ({ kind: "continue" }));
  }

  // Organizer controls; the engine refuses anyone else.
  public pause(key: CampaignKey, userId: UserId, interactionId: string): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, () => ({ kind: "pauseCampaign", reason: "organizer" }));
  }

  public closeRound(key: CampaignKey, userId: UserId, interactionId: string): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, () => ({ kind: "closeRound" }));
  }

  // The DM could not resolve a round; the organizer asks it to try again.
  public retryPlan(key: CampaignKey, userId: UserId, interactionId: string): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, () => ({ kind: "retryPlan" }));
  }

  public rest(key: CampaignKey, userId: UserId, rest: "short" | "long", interactionId: string): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, () => ({ kind: "takeRest", rest }));
  }

  private asHero(key: CampaignKey, userId: UserId, interactionId: string, command: (characterId: CharacterId) => CampaignCommand): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, (state) => {
      const heroId = state.members[userId]?.characterId;
      return heroId === null || heroId === undefined ? "noHero" : command(heroId);
    });
  }

  private async perform(
    key: CampaignKey,
    userId: UserId,
    interactionId: string,
    build: (state: CampaignState) => CampaignCommand | PlayRefusal,
  ): Promise<PlayResult> {
    const loaded = await this.options.unitOfWork.transaction(async (tx) => ({ record: await tx.loadRecord(key), stored: await tx.loadCampaign(key) }));
    if (loaded.record === undefined || loaded.stored === undefined) return { kind: "refused", reason: loaded.record === undefined ? "notFound" : "notActive" };
    if (loaded.record.record.lifecycle === "archived" || loaded.record.record.lifecycle === "lobby") return { kind: "refused", reason: "notActive" };
    const command = build(loaded.stored.state);
    if (typeof command === "string") return { kind: "refused", reason: command };
    const outcome = await this.options.bus.execute(key, command, { commandId: `dnd:${interactionId}`, actor: { kind: "user", userId } });
    if (outcome.kind === "notFound") return { kind: "refused", reason: "notFound" };
    if (outcome.kind === "rejected") return { kind: "refused", reason: outcome.rejection.code };
    this.options.refresher.refresh(key);
    return { kind: "ok" };
  }
}

// "c-mira-2" is the second hero played from the "c-mira" preset.
function baseHeroId(id: string): string {
  return id.replace(/-\d+$/, "");
}

function roman(value: number): string {
  const numerals: readonly [number, string][] = [[10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let rest = value;
  let text = "";
  for (const [size, numeral] of numerals) {
    while (rest >= size) {
      text += numeral;
      rest -= size;
    }
  }
  return text;
}
