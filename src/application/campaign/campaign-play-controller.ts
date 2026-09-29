import { raiseToLevel } from "../../domain/campaign/character/leveling.js";
import type { ContentId } from "../../domain/campaign/rules/content-id.js";
import type { CampaignCommand, CombatCommand } from "../../domain/campaign/commands/campaign-command.js";
import type { Ability } from "../../domain/campaign/rules/effects.js";
import { actingHero } from "../../domain/campaign/engine/members.js";
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

// What a manager can do to a game from the hub.
export type ManageAction = "pause" | "resume" | "closeRound" | "retry" | "retryFight" | "retell" | "illustrate" | "shortRest" | "longRest";

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
    const state = loaded.stored.state;
    const partyLevel = Math.max(1, ...Object.values(state.characters).filter((other) => !isFallen(state, other.id)).map((other) => other.level));
    const joining = raiseToLevel({ ...sheet, className, id: `${presetId}-${used + 1}`, ownerUserId: userId, name: used === 0 ? preset.name : `${preset.name} ${roman(used + 1)}` }, partyLevel);
    const outcome = await this.options.bus.execute(
      key,
      { kind: "joinHero", sheet: joining },
      { commandId: `dnd:${interactionId}`, actor: { kind: "user", userId } },
    );
    if (outcome.kind === "notFound") return { kind: "refused", reason: "notFound" };
    if (outcome.kind === "rejected") return { kind: "refused", reason: outcome.rejection.code };
    this.options.refresher.refresh(key);
    return { kind: "ok" };
  }

  // The organizer raises every living hero to `level` (milestone leveling).
  public raiseLevel(key: CampaignKey, userId: UserId | null, level: number, interactionId: string): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, () => ({ kind: "raiseLevel", level }));
  }

  // The hero's next level lands in `buildClass` (their own, or a multiclass they qualify for).
  public chooseClassLevel(key: CampaignKey, userId: UserId, buildClass: string, skillChoice: string | undefined, interactionId: string): Promise<PlayResult> {
    return this.asHero(key, userId, interactionId, (characterId) => ({ kind: "chooseClassLevel", characterId, buildClass, ...(skillChoice === undefined ? {} : { skillChoice }) }));
  }

  // roundNumber is the round the form was opened for; the engine refuses it in any other round.
  public submitAction(key: CampaignKey, userId: UserId, text: string, interactionId: string, roundNumber?: number): Promise<PlayResult> {
    return this.asHero(key, userId, interactionId, (characterId) => ({ kind: "submitAction", characterId, text, ...(roundNumber === undefined ? {} : { roundNumber }) }));
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

  // Outside a fight: put on or take off armor or a shield the hero carries.
  public wear(key: CampaignKey, userId: UserId, itemId: ContentId<"item">, interactionId: string): Promise<PlayResult> {
    return this.asHero(key, userId, interactionId, (characterId) => ({ kind: "wearItem", characterId, itemId }));
  }

  public remove(key: CampaignKey, userId: UserId, itemId: ContentId<"item">, interactionId: string): Promise<PlayResult> {
    return this.asHero(key, userId, interactionId, (characterId) => ({ kind: "removeItem", characterId, itemId }));
  }

  // In-character words: no action, no cost.
  public speak(key: CampaignKey, userId: UserId, text: string, interactionId: string): Promise<PlayResult> {
    return this.asHero(key, userId, interactionId, (characterId) => ({ kind: "speak", characterId, text }));
  }

  // Stops play for everyone; no hero needed, and nobody is told who asked.
  public safety(key: CampaignKey, userId: UserId, interactionId: string): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, () => ({ kind: "pauseCampaign", reason: "safety" }));
  }

  // Outside a fight: drink a potion, stash an item, or take one from the stash.
  public useItem(key: CampaignKey, userId: UserId, itemId: ContentId<"item">, interactionId: string): Promise<PlayResult> {
    return this.asHero(key, userId, interactionId, (characterId) => ({ kind: "useItem", characterId, itemId }));
  }

  public stash(key: CampaignKey, userId: UserId, itemId: ContentId<"item">, interactionId: string): Promise<PlayResult> {
    return this.asHero(key, userId, interactionId, (characterId) => ({ kind: "stashItem", characterId, itemId }));
  }

  public takeFromStash(key: CampaignKey, userId: UserId, itemId: ContentId<"item">, interactionId: string): Promise<PlayResult> {
    return this.asHero(key, userId, interactionId, (characterId) => ({ kind: "takeFromStash", characterId, itemId }));
  }

  // A gift to another hero, who has to accept it.
  public give(key: CampaignKey, userId: UserId, itemId: ContentId<"item">, toCharacterId: CharacterId, interactionId: string): Promise<PlayResult> {
    return this.asHero(key, userId, interactionId, (characterId) => ({ kind: "offerItem", fromCharacterId: characterId, toCharacterId, give: itemId, want: null }));
  }

  public answerOffer(key: CampaignKey, userId: UserId, offerId: string, answer: "accept" | "decline" | "cancel", interactionId: string): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, () => (answer === "cancel" ? { kind: "cancelOffer", offerId } : { kind: "respondToOffer", offerId, accept: answer === "accept" }));
  }

  // A turn action for the clicker's own hero (the engine checks whose turn it is).
  // On an away friend's turn, a proxy they named acts as that friend's hero.
  public combat(key: CampaignKey, userId: UserId, interactionId: string, command: (characterId: CharacterId) => CombatCommand): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, (state) => {
      const heroId = actingHero(state, userId);
      return heroId === null ? "noHero" : command(heroId);
    });
  }

  // Spends one unspent Ability Score Improvement (the engine checks there is
  // one owed and caps each ability at 20).
  public chooseAsi(key: CampaignKey, userId: UserId, allocation: { readonly plusTwo: Ability } | { readonly plusOne: readonly [Ability, Ability] }, interactionId: string): Promise<PlayResult> {
    return this.asHero(key, userId, interactionId, (characterId) => ({ kind: "chooseAsi", characterId, allocation }));
  }

  public ready(key: CampaignKey, userId: UserId, interactionId: string): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, () => ({ kind: "ready" }));
  }

  // Organizer: open the first round without waiting for everyone.
  public begin(key: CampaignKey, userId: UserId, interactionId: string): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, () => ({ kind: "beginPlay" }));
  }

  public continue(key: CampaignKey, userId: UserId, interactionId: string): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, () => ({ kind: "continue" }));
  }

  // Names another player to play this player's hero in fights while they are away, or takes it back (null).
  public proxy(key: CampaignKey, userId: UserId, proxyUserId: UserId | null, interactionId: string): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, () => (proxyUserId === null ? { kind: "revokeProxy" } : { kind: "grantProxy", proxyUserId }));
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

  // A DnD Admin (checked by the caller, which knows the server's role) runs
  // an organizer control on a game they do not organize. The engine still
  // sees the organizer's own rights, so it decides exactly as it would for them.
  public manage(key: CampaignKey, verb: ManageAction, interactionId: string): Promise<PlayResult> {
    const command = (state: CampaignState): CampaignCommand =>
      verb === "pause"
        ? { kind: "pauseCampaign", reason: "organizer" }
        : verb === "resume"
          ? { kind: "continue" }
          : verb === "closeRound"
            ? { kind: "closeRound" }
            : verb === "retry"
              ? { kind: "retryPlan" }
              : verb === "retryFight"
                ? { kind: "retryEncounter" }
                : verb === "retell"
                  ? { kind: "regenerateNarration", roundNumber: state.lastNarratedRound }
                  : verb === "illustrate"
                    ? { kind: "illustrateMoment", roundNumber: state.lastNarratedRound }
                    : { kind: "takeRest", rest: verb === "longRest" ? "long" : "short" };
    return this.perform(key, null, interactionId, command);
  }

  // Organizer: paint the last posted picture again ("" when there is none, which the engine refuses).
  public redoPicture(key: CampaignKey, subject: string, interactionId: string): Promise<PlayResult> {
    return this.perform(key, null, interactionId, () => ({ kind: "redoPicture", subject }));
  }

  private asHero(key: CampaignKey, userId: UserId, interactionId: string, command: (characterId: CharacterId) => CampaignCommand): Promise<PlayResult> {
    return this.perform(key, userId, interactionId, (state) => {
      const heroId = state.members[userId]?.characterId;
      return heroId === null || heroId === undefined ? "noHero" : command(heroId);
    });
  }

  private async perform(
    key: CampaignKey,
    userId: UserId | null,
    interactionId: string,
    build: (state: CampaignState) => CampaignCommand | PlayRefusal,
  ): Promise<PlayResult> {
    const loaded = await this.options.unitOfWork.transaction(async (tx) => ({ record: await tx.loadRecord(key), stored: await tx.loadCampaign(key) }));
    if (loaded.record === undefined || loaded.stored === undefined) return { kind: "refused", reason: loaded.record === undefined ? "notFound" : "notActive" };
    if (loaded.record.record.lifecycle === "archived" || loaded.record.record.lifecycle === "lobby") return { kind: "refused", reason: "notActive" };
    const command = build(loaded.stored.state);
    if (typeof command === "string") return { kind: "refused", reason: command };
    const actor = userId ?? loaded.stored.state.organizerId;
    const outcome = await this.options.bus.execute(key, command, { commandId: `dnd:${interactionId}`, actor: { kind: "user", userId: actor } });
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
