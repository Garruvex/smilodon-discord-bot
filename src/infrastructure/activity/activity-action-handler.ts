import { randomUUID } from "node:crypto";
import type { CampaignKey } from "../../application/campaign/ports/campaign-store.js";
import type { UserId } from "../../domain/campaign/core/ids.js";
import type { ContentId } from "../../domain/campaign/rules/content-id.js";
import { isTimeOfDay, isWeather, type TimeOfDay, type Weather } from "../../domain/campaign/rules/world-rules.js";
import { abilities, type Ability } from "../../domain/campaign/rules/effects.js";
import { maxActionLength } from "../../domain/campaign/engine/rounds.js";
import { maxSpeechLength } from "../../domain/campaign/engine/speech.js";
import type { CampaignLobbyService } from "../../application/campaign/campaign-lobby-service.js";
import type { CampaignPlayController, PlayResult } from "../../application/campaign/campaign-play-controller.js";
import type { CharacterLibrary } from "../../application/campaign/library/character-library.js";
import { houseRulePresets } from "../../domain/campaign/rules/house-rules.js";
import { parseActivityAction } from "./activity-api-contract.js";

export type ActivityActionResult = { readonly kind: "ok" } | { readonly kind: "refused"; readonly reason: string };

export function createActivityActionHandler(options: {
  readonly lobby: CampaignLobbyService;
  readonly play: CampaignPlayController;
  readonly library?: CharacterLibrary;
  readonly onAccepted?: (key: CampaignKey) => void;
}): (key: CampaignKey, userId: UserId, input: unknown) => Promise<ActivityActionResult> {
  const { lobby, play: activityPlay, library } = options;
  const handle: (key: CampaignKey, userId: UserId, input: unknown) => Promise<ActivityActionResult> = async (key, userId, input) => {
        const action = parseActivityAction(input);
        if (action === null) return { kind: "refused", reason: "invalidAction" };
        const id = randomUUID();
        const textValue = (value: unknown, max = 128): string | null => typeof value === "string" && value.trim().length > 0 && value.length <= max ? value.trim() : null;
        const integerValue = (value: unknown, min = 0, max = 9): number | null => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
        const stringList = (value: unknown): string[] | null => Array.isArray(value) && value.length > 0 && value.length <= 6 && value.every((item) => typeof item === "string" && item.length <= 128) ? value : null;
        switch (action.kind) {
          case "chooseHero": {
            const heroId = textValue(action.heroId);
            if (heroId === null) return { kind: "refused", reason: "invalidAction" };
            return lobby.chooseHero(key, userId, heroId).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          }
          case "joinLobby": return lobby.joinFromActivity(key, userId).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          case "leaveLobby": return lobby.leave(key, userId).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          case "requestJoin": return lobby.requestOngoingJoin(key, userId).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          case "chooseSaved": {
            const snapshotId = textValue(action.snapshotId);
            if (snapshotId === null) return { kind: "refused", reason: "invalidAction" };
            const result = await lobby.chooseSaved(key, userId, snapshotId);
            return result.kind === "ok" ? { kind: "ok" } : { kind: "refused", reason: result.kind === "conflicts" ? "characterIncompatible" : result.reason };
          }
          case "startLobby": {
            const result = await lobby.start(key, userId);
            return result.kind === "ok" ? { kind: "ok" } : { kind: "refused", reason: result.reason };
          }
          case "acceptInvite": return lobby.acceptOngoingInvite(key, userId).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          case "joinHero": {
            const heroRef = textValue(action.heroRef);
            if (heroRef === null) return { kind: "refused", reason: "invalidAction" };
            return lobby.joinOngoingHero(key, userId, heroRef, id).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          }
          // A player whose hero has fallen takes a new one (the engine and the lobby record both learn of it).
          case "replaceHero": {
            const heroRef = textValue(action.heroRef);
            if (heroRef === null) return { kind: "refused", reason: "invalidAction" };
            const entrance = typeof action.entrance === "string" ? action.entrance.slice(0, 600) : undefined;
            return lobby.replaceFallenHero(key, userId, heroRef, entrance, id).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          }
          case "retireSeat": {
            const target = textValue(action.userId, 64);
            if (target === null) return { kind: "refused", reason: "invalidAction" };
            return lobby.retireSeat(key, userId, target, id).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          }
          case "setPresence": {
            const target = textValue(action.userId, 64);
            if (target === null || typeof action.away !== "boolean") return { kind: "refused", reason: "invalidAction" };
            return activityPlay.setPresenceFor(key, userId, target, action.away, id).then(mapPlayResult);
          }
          case "withdrawJoin": return lobby.withdrawOngoingJoin(key, userId).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          case "submit": {
            const text = textValue(action.text, maxActionLength);
            if (text === null) return { kind: "refused", reason: "invalidAction" };
            const roundNumber = typeof action.roundNumber === "number" && Number.isInteger(action.roundNumber) ? action.roundNumber : undefined;
            const sceneId = textValue(action.sceneId, 200) ?? undefined;
            return activityPlay.submitAction(key, userId, text, id, roundNumber, sceneId).then(mapPlayResult);
          }
          case "speak": {
            const text = textValue(action.text, maxSpeechLength);
            if (text === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.speak(key, userId, text, id).then(mapPlayResult);
          }
          case "pass": return activityPlay.pass(key, userId, id).then(mapPlayResult);
          case "away": return activityPlay.away(key, userId, id).then(mapPlayResult);
          case "back": return activityPlay.back(key, userId, id).then(mapPlayResult);
          case "toggleMoveObjection": return activityPlay.toggleMoveObjection(key, userId, id).then(mapPlayResult);
          case "moveVote": {
            if (action.choice !== "go" && action.choice !== "stay") return { kind: "refused", reason: "invalidAction" };
            return activityPlay.voteOnMove(key, userId, action.choice, id).then(mapPlayResult);
          }
          case "roll": return activityPlay.roll(key, userId, id).then(mapPlayResult);
          case "ready": return activityPlay.ready(key, userId, id).then(mapPlayResult);
          case "begin": return activityPlay.begin(key, userId, id).then(mapPlayResult);
          case "continue": return activityPlay.continue(key, userId, id).then(mapPlayResult);
          case "attack": {
            const targetId = textValue(action.targetId);
            const weaponId = textValue(action.weaponId);
            if (targetId === null || weaponId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatAttack", combatantId: characterId, targetId, weapon: weaponId as ContentId<"item">, ...(action.offHand === true ? { offHand: true as const } : {}), ...(action.nonlethal === true ? { nonlethal: true as const } : {}) })).then(mapPlayResult);
          }
          case "move": {
            const zoneId = textValue(action.zoneId);
            if (zoneId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatMove", combatantId: characterId, zoneId })).then(mapPlayResult);
          }
          case "engage": {
            const targetId = textValue(action.targetId);
            if (targetId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatEngage", combatantId: characterId, targetId })).then(mapPlayResult);
          }
          case "withdraw": return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatWithdraw", combatantId: characterId })).then(mapPlayResult);
          case "dash": return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatDash", combatantId: characterId })).then(mapPlayResult);
          case "disengage": return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatDisengage", combatantId: characterId })).then(mapPlayResult);
          case "feature": {
            const featureId = textValue(action.featureId);
            if (featureId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatUseFeature", combatantId: characterId, featureId: featureId as ContentId<"feature"> })).then(mapPlayResult);
          }
          case "combatItem": {
            const itemId = textValue(action.itemId);
            if (itemId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatUseItem", combatantId: characterId, itemId: itemId as ContentId<"item"> })).then(mapPlayResult);
          }
          case "shield": {
            const itemId = textValue(action.itemId);
            if (itemId === null || typeof action.on !== "boolean") return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatShield", combatantId: characterId, itemId: itemId as ContentId<"item">, on: action.on as boolean })).then(mapPlayResult);
          }
          case "wildShape": {
            const monsterId = action.monsterId === null ? null : textValue(action.monsterId);
            if (action.monsterId !== null && monsterId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatWildShape", combatantId: characterId, ...(monsterId === null ? {} : { monsterId: monsterId as ContentId<"monster"> }) })).then(mapPlayResult);
          }
          case "moveScene": {
            const sceneId = textValue(action.sceneId);
            if (sceneId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.proposeMove(key, userId, sceneId, id).then(mapPlayResult);
          }
          case "endTurn": return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "endTurn", combatantId: characterId })).then(mapPlayResult);
          case "combatDodge": return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatDodge", combatantId: characterId })).then(mapPlayResult);
          case "combatSpell": {
            const spellId = textValue(action.spellId);
            const slotLevel = integerValue(action.slotLevel);
            const targetIds = stringList(action.targetIds);
            if (spellId === null || slotLevel === null || targetIds === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatCast", combatantId: characterId, spellId: spellId as ContentId<"spell">, slotLevel, targetIds })).then(mapPlayResult);
          }
          case "teleport": {
            const spellId = textValue(action.spellId);
            const slotLevel = integerValue(action.slotLevel);
            const zoneId = textValue(action.zoneId);
            if (spellId === null || slotLevel === null || zoneId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatCast", combatantId: characterId, spellId: spellId as ContentId<"spell">, slotLevel, targetIds: [characterId], zoneId })).then(mapPlayResult);
          }
          case "exploreSpell": {
            const spellId = textValue(action.spellId);
            if (spellId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.castSpell(key, userId, spellId as ContentId<"spell">, id).then(mapPlayResult);
          }
          // Stopping play is for every player; pausing and resting are the organizer's (the engine refuses anyone else).
          case "safetyStop": return activityPlay.safety(key, userId, id).then(mapPlayResult);
          case "pause": return activityPlay.pause(key, userId, id).then(mapPlayResult);
          case "queueRest": {
            const rest = action.rest === "short" || action.rest === "long" ? action.rest : action.rest === "none" ? null : undefined;
            if (rest === undefined) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.queueRest(key, userId, rest, id).then(mapPlayResult);
          }
          case "proposeRest": {
            if (action.rest !== "short" && action.rest !== "long") return { kind: "refused", reason: "invalidAction" };
            return activityPlay.proposeRest(key, userId, action.rest, id).then(mapPlayResult);
          }
          case "answerRestVote": {
            if (typeof action.agree !== "boolean") return { kind: "refused", reason: "invalidAction" };
            return activityPlay.answerRestVote(key, userId, action.agree, id).then(mapPlayResult);
          }
          case "dismissCompanion": {
            const companionId = textValue(action.companionId);
            if (companionId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.dismissCompanion(key, userId, companionId, id).then(mapPlayResult);
          }
          case "setProxy": {
            const proxyUserId = action.userId === null ? null : textValue(action.userId);
            if (action.userId !== null && proxyUserId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.proxy(key, userId, proxyUserId as UserId | null, id).then(mapPlayResult);
          }
          case "runGame": {
            const verb = textValue(action.verb, 32);
            if (verb === null || !["closeRound", "retry", "retryFight", "retell", "illustrate", "illustrateScene"].includes(verb)) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.manage(key, verb as "closeRound" | "retry" | "retryFight" | "retell" | "illustrate" | "illustrateScene", id, userId).then(mapPlayResult);
          }
          case "raiseLevel": {
            const level = integerValue(action.level);
            if (level === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.raiseLevel(key, userId, level, id).then(mapPlayResult);
          }
          case "setWorld": {
            const day = action.day === undefined ? undefined : integerValue(action.day);
            const time = action.time === undefined || action.time === "" ? undefined : textValue(action.time, 16);
            const weather = action.weather === undefined || action.weather === "" ? undefined : textValue(action.weather, 16);
            const note = action.note === undefined || action.note === "" ? undefined : textValue(action.note, 200);
            if (day === null || (time !== undefined && (time === null || !isTimeOfDay(time))) || (weather !== undefined && (weather === null || (weather !== "none" && !isWeather(weather)))) || note === null) return { kind: "refused", reason: "invalidAction" };
            if (day === undefined && time === undefined && weather === undefined) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.setWorld(key, userId, { ...(day === undefined ? {} : { day }), ...(time === undefined ? {} : { time: time as TimeOfDay }), ...(weather === undefined ? {} : { weather: weather === "none" ? null : (weather as Weather) }), ...(note === undefined ? {} : { note }) }, id).then(mapPlayResult);
          }
          case "saveProgress": {
            if (library === undefined) return { kind: "refused", reason: "libraryUnavailable" };
            const saved = await library.saveProgress(userId, key);
            if (saved.kind === "refused") return { kind: "refused", reason: saved.reason };
            return { kind: "ok" };
          }
          case "setHouseRule": {
            const ruleId = textValue(action.ruleId, 64);
            const value = textValue(action.value, 64);
            if (ruleId === null || value === null) return { kind: "refused", reason: "invalidAction" };
            return lobby.setHouseRules(key, userId, { [ruleId]: value }).then((result) => (result.kind === "refused" ? { kind: "refused" as const, reason: result.reason } : { kind: "ok" as const }));
          }
          case "applyRulePreset": {
            const presetId = textValue(action.presetId, 32);
            const preset = houseRulePresets.find((candidate) => candidate.id === presetId);
            if (preset === undefined) return { kind: "refused", reason: "invalidAction" };
            return lobby.setHouseRules(key, userId, preset.values).then((result) => (result.kind === "refused" ? { kind: "refused" as const, reason: result.reason } : { kind: "ok" as const }));
          }
          case "reopen": return lobby.reopen(key, userId).then((result) => (result.kind === "refused" ? { kind: "refused" as const, reason: result.reason } : { kind: "ok" as const }));
          case "spendHitDice": {
            const count = integerValue(action.count);
            if (count === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.spendHitDice(key, userId, count, id).then(mapPlayResult);
          }
          // Level-up choices. The engine checks every one (an improvement owed, the cap of 20, a class the hero qualifies for).
          case "chooseAsi": {
            const first = textValue(action.plusTwo, 3);
            const pair = Array.isArray(action.plusOne) ? action.plusOne.map((entry) => textValue(entry, 3)) : [];
            const isAbility = (value: string | null): value is Ability => value !== null && (abilities as readonly string[]).includes(value);
            if (isAbility(first)) return activityPlay.chooseAsi(key, userId, { plusTwo: first }, id).then(mapPlayResult);
            const [one, two] = pair;
            if (pair.length === 2 && isAbility(one ?? null) && isAbility(two ?? null)) return activityPlay.chooseAsi(key, userId, { plusOne: [one as Ability, two as Ability] }, id).then(mapPlayResult);
            return { kind: "refused", reason: "invalidAction" };
          }
          case "chooseClassLevel": {
            const buildClass = textValue(action.buildClass, 32);
            if (buildClass === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.chooseClassLevel(key, userId, buildClass, textValue(action.skill, 32) ?? undefined, id).then(mapPlayResult);
          }
          case "chooseFightingStyle": {
            const styleId = textValue(action.styleId);
            if (styleId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.chooseFightingStyle(key, userId, styleId, id).then(mapPlayResult);
          }
          case "chooseWarlockOptions": {
            const invocations = Array.isArray(action.invocations) ? action.invocations.flatMap((entry) => textValue(entry) ?? []) : undefined;
            const pactBoon = textValue(action.pactBoon) ?? undefined;
            if (invocations === undefined && pactBoon === undefined) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.chooseWarlockOptions(key, userId, { ...(invocations === undefined ? {} : { invocations }), ...(pactBoon === undefined ? {} : { pactBoon }) }, id).then(mapPlayResult);
          }
          case "healSpell":
          case "reviveSpell": {
            const spellId = textValue(action.spellId);
            const slotLevel = integerValue(action.slotLevel);
            const targetId = textValue(action.targetId);
            if (spellId === null || slotLevel === null || targetId === null) return { kind: "refused", reason: "invalidAction" };
            const result = action.kind === "healSpell"
              ? await activityPlay.healSpell(key, userId, spellId as ContentId<"spell">, slotLevel, targetId, id)
              : await activityPlay.reviveSpell(key, userId, spellId as ContentId<"spell">, slotLevel, targetId, id);
            return mapPlayResult(result);
          }
          case "summonCompanion": {
            const spellId = textValue(action.spellId);
            const slotLevel = integerValue(action.slotLevel);
            if (spellId === null || slotLevel === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.summonCompanion(key, userId, spellId as ContentId<"spell">, slotLevel, id).then(mapPlayResult);
          }
          case "askNpc": {
            const npcId = textValue(action.npcId);
            const question = textValue(action.question, 500);
            if (npcId === null || question === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.ask(key, userId, npcId, question, id).then(mapPlayResult);
          }
          case "pressNpc": {
            const npcId = textValue(action.npcId);
            const skill = textValue(action.skill, 32);
            if (npcId === null || !["insight", "persuasion", "deception", "intimidation"].includes(skill ?? "")) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.press(key, userId, npcId, skill as "insight" | "persuasion" | "deception" | "intimidation", id).then(mapPlayResult);
          }
          case "shop": {
            const npcId = textValue(action.npcId);
            const itemId = textValue(action.itemId);
            if (npcId === null || itemId === null || (action.direction !== "buy" && action.direction !== "sell")) return { kind: "refused", reason: "invalidAction" };
            // A skill to haggle with; empty or absent pays the list price.
            const haggle = textValue(action.haggle, 32);
            if (haggle !== null && haggle !== "" && !["persuasion", "deception", "intimidation"].includes(haggle)) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.trade(key, userId, { npcId, itemId: itemId as ContentId<"item">, direction: action.direction, ...(haggle === null || haggle === "" ? {} : { haggle: haggle as "persuasion" | "deception" | "intimidation" }) }, id).then(mapPlayResult);
          }
          case "useItem": {
            const itemId = textValue(action.itemId);
            if (itemId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.useItem(key, userId, itemId as ContentId<"item">, id).then(mapPlayResult);
          }
          case "stashItem":
          case "takeFromStash": {
            const itemId = textValue(action.itemId);
            if (itemId === null) return { kind: "refused", reason: "invalidAction" };
            const result = action.kind === "stashItem"
              ? await activityPlay.stash(key, userId, itemId as ContentId<"item">, id)
              : await activityPlay.takeFromStash(key, userId, itemId as ContentId<"item">, id);
            return mapPlayResult(result);
          }
          case "giveItem": {
            const itemId = textValue(action.itemId);
            const toCharacterId = textValue(action.toCharacterId);
            if (itemId === null || toCharacterId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.give(key, userId, itemId as ContentId<"item">, toCharacterId, id).then(mapPlayResult);
          }
          case "offerResponse": {
            const offerId = textValue(action.offerId);
            const answer = action.answer;
            if (offerId === null || (answer !== "accept" && answer !== "decline" && answer !== "cancel")) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.answerOffer(key, userId, offerId, answer, id).then(mapPlayResult);
          }
          case "wearItem":
          case "removeItem": {
            const itemId = textValue(action.itemId);
            if (itemId === null) return { kind: "refused", reason: "invalidAction" };
            const result = action.kind === "wearItem"
              ? await activityPlay.wear(key, userId, itemId as ContentId<"item">, id)
              : await activityPlay.remove(key, userId, itemId as ContentId<"item">, id);
            return mapPlayResult(result);
          }
          case "reaction": {
            const spellId = action.spellId === null ? null : textValue(action.spellId);
            const slotLevel = action.slotLevel === null ? null : integerValue(action.slotLevel);
            if (action.spellId !== null && (spellId === null || slotLevel === null)) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatReact", combatantId: characterId, spellId: spellId as ContentId<"spell"> | null })).then(mapPlayResult);
          }
          case "smite": {
            const slotLevel = action.slotLevel === null ? null : integerValue(action.slotLevel);
            if (action.slotLevel !== null && slotLevel === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatSmite", combatantId: characterId, slotLevel })).then(mapPlayResult);
          }
          case "opportunityAttack": {
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatOpportunityAttack", combatantId: characterId, take: action.accept === true })).then(mapPlayResult);
          }
          default: return { kind: "refused", reason: "invalidAction" };
        }
  };
  return async (key, userId, input) => {
    const result = await handle(key, userId, input);
    // Coalesced by CampaignCardService; delivery work still redraws the panel
    // after narration. This also covers actions that queue no delivery at all.
    if (result.kind === "ok") {
      try { options.onAccepted?.(key); } catch { /* The accepted game action remains accepted. */ }
    }
    return result;
  };
}

function mapPlayResult(result: PlayResult): ActivityActionResult {
  return result.kind === "ok" ? result : { kind: "refused", reason: result.reason };
}

