import type { AdventureBible } from "../../domain/campaign/adventure/adventure-bible.js";
import type { UserId } from "../../domain/campaign/core/ids.js";
import { actingHero } from "../../domain/campaign/engine/members.js";
import { isFallen, presentMembers, type CampaignState } from "../../domain/campaign/state/campaign-state.js";
import type { SealedContent, Glossary } from "../../domain/campaign/rules/content-registry.js";
import type { CheckTest } from "../../domain/campaign/character/character-sheet.js";
import { findScene } from "../../domain/campaign/adventure/adventure-bible.js";
import { resolveHouseRules } from "../../domain/campaign/rules/house-rules.js";
import { buildPanelView, buildPartyView, buildHeroView, buildReactionView, buildSmiteView, buildOpportunityAttackView } from "./views/campaign-views.js";
import { buildExploreView, buildShopView, type ExploreView, type ShopView } from "./views/explore-view.js";
import { buildTurnView } from "./views/turn-view.js";
import type { CampaignRecord } from "./ports/campaign-record.js";
import { readyToStart } from "../../domain/campaign/lobby/lobby.js";
import { texts } from "../i18n/texts.js";
import { buildMapView } from "./views/map-view.js";

// A picture is on disk once it is made, even while its Discord post is still being retried.
const hasPicture = (status: string | undefined): boolean => status === "done" || status === "made";

export interface ActivityTableView {
  readonly kind: "table";
  readonly language: CampaignRecord["language"];
  // Class names in the game's language, keyed by the class id.
  readonly classNames: Readonly<Record<string, string>>;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly adventureTitle: string;
  readonly sceneId: string | null;
  readonly mode: string;
  readonly ownPresence: "present" | "away";
  readonly roundNumber: number | null;
  readonly scene: { readonly title: string; readonly description: string; readonly imageUrl: string | null };
  // present and needed: how many players vote, and how many Stay votes keep the party where it is. closesAt: when the window closes (epoch ms), or null.
  readonly pendingMove: null | { readonly sceneId: string; readonly sceneTitle: string; readonly sceneDescription: string; readonly proposedBy: string | null; readonly supporters: readonly string[]; readonly staying: readonly string[]; readonly choiceByYou: "go" | "stay" | null; readonly present: number; readonly needed: number; readonly closesAt: number | null };
  readonly map:
    | { readonly kind: "battlefield"; readonly zones: readonly { readonly id: string; readonly name: string; readonly lighting: string | null; readonly cover: string | null; readonly difficult: boolean; readonly canMove: boolean; readonly occupants: readonly { readonly name: string; readonly side: "party" | "foes"; readonly rank?: "boss" | "elite" | "minion" | "standard"; readonly active: boolean; readonly hp: number; readonly maxHp: number }[] }[]; readonly edges: readonly { readonly from: string; readonly to: string; readonly feet: number }[] }
    | { readonly kind: "journey"; readonly nodes: readonly { readonly id: string; readonly title: string; readonly status: "current" | "visited" | "known" | "reachable" | "locked"; readonly locked: boolean; readonly deadEnd: boolean; readonly canTravel: boolean; readonly column: number; readonly row: number }[]; readonly routes: readonly { readonly from: string; readonly to: string; readonly oneWay: boolean }[] };
  // Every word of the map, in the game's language.
  readonly mapText: Readonly<Record<"journeyKind" | "journeyTitle" | "tacticalKind" | "battlefield" | "keyParty" | "keyFoes" | "keyHere" | "keyOpen" | "keyLocked" | "empty" | "routeLabel" | "here" | "deadEnd" | "locked" | "visited" | "mapped" | "openRoute" | "openGround" | "difficult" | "coverHalf" | "coverThreeQuarters" | "lightBright" | "lightDim" | "lightDark" | "moveHere", string>>;
  readonly yourTurn: boolean;
  readonly canBegin: boolean;
  readonly activeName: string | null;
  readonly upcomingNames: readonly string[];
  readonly party: readonly {
    readonly characterId: string;
    readonly name: string;
    readonly className: string | null;
    readonly raceName: string | null;
    readonly level: number;
    readonly hp: number;
    readonly maxHp: number;
    readonly armorClass: number;
    readonly presence: "present" | "away";
    readonly down: boolean;
    readonly fallen: boolean;
    readonly conditions: readonly string[];
    readonly imageUrl: string | null;
    readonly isYou: boolean;
    readonly tableStatus: "acting" | "submitted" | "passed" | "missed" | "away" | "waiting";
  }[];
  readonly foes: readonly {
    readonly name: string;
    readonly rank?: "boss" | "elite" | "minion" | "standard";
    readonly hp: number;
    readonly maxHp: number;
    readonly band: string;
    readonly zone: string;
    readonly active: boolean;
  }[];
  readonly offers: readonly { readonly id: string; readonly fromCharacterId: string; readonly toCharacterId: string; readonly fromName: string; readonly toName: string; readonly itemName: string; readonly direction: "incoming" | "outgoing" }[];
  // Full inventory/resource details are disclosed for the requesting player's hero only.
  readonly myHero: null | {
    readonly characterId: string;
    readonly imageUrl: string | null;
    readonly name: string;
    readonly className: string | null;
    readonly raceName: string | null;
    readonly level: number;
    readonly hp: number;
    readonly maxHp: number;
    readonly armorClass: number;
    readonly gold: number;
    readonly partyGold: number;
    readonly weapons: readonly string[];
    readonly worn: readonly string[];
    readonly pack: readonly { readonly id: string; readonly name: string; readonly count: number }[];
    readonly stash: readonly { readonly id: string; readonly name: string; readonly count: number }[];
    readonly inventoryChoices: readonly { readonly id: string; readonly name: string; readonly count: number; readonly wearable: boolean; readonly worn: boolean }[];
    readonly usablePotions: readonly { readonly id: string; readonly name: string; readonly count: number }[];
    readonly cantrips: readonly string[];
    readonly prepared: readonly string[];
    readonly slots: readonly { readonly level: number; readonly left: number; readonly max: number }[];
    readonly pactSlots: readonly { readonly level: number; readonly left: number; readonly max: number }[];
    readonly uses: readonly { readonly id: string; readonly name: string; readonly left: number; readonly max: number }[];
  };
  readonly turn: ReturnType<typeof buildTurnView>;
  readonly explore: (ExploreView & { readonly shops: readonly ShopView[] }) | null;
  readonly pendingRoll: null | { readonly checkId: string; readonly test: CheckTest; readonly action: string | null };
  readonly pendingRollCount: number;
  // The viewer's newest settled rolls (a check, a press); the client shows each one once.
  readonly rolls: readonly { readonly id: string; readonly test: CheckTest; readonly natural: number; readonly total: number; readonly dc: number; readonly success: boolean }[];
  readonly submittedCount: number;
  readonly participantCount: number;
  readonly submission: "action" | "pass" | "missed" | "excused" | null;
  readonly submissionText: string | null;
  readonly submissionRevision: number | null;
  readonly canAcceptInvite: boolean;
  readonly joinChoices: readonly { readonly id: string; readonly name: string; readonly className: string }[];
  readonly joinRequestStatus: "requested" | "invited" | "approved" | "queued" | null;
  readonly queuedJoin: null | { readonly heroName: string; readonly encounterRound: number | null; readonly nextEncounter: boolean };
  readonly savedHeroChoices: readonly { readonly id: string; readonly name: string; readonly className: string }[];
  readonly reaction: ReturnType<typeof buildReactionView>;
  readonly reactionIsYours: boolean;
  readonly smite: ReturnType<typeof buildSmiteView>;
  readonly smiteIsYours: boolean;
  readonly opportunityAttack: ReturnType<typeof buildOpportunityAttackView>;
  readonly opportunityAttackIsYours: boolean;
}

export interface ActivityLobbyView {
  readonly kind: "lobby";
  readonly language: CampaignRecord["language"];
  readonly classNames: Readonly<Record<string, string>>;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly adventureTitle: string;
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly canStart: boolean;
  readonly startBlockReason: "notEnoughPlayers" | "notReady" | null;
  readonly selectedHeroId: string | null;
  readonly selectedHeroName: string | null;
  readonly selectedHeroClass: string | null;
  readonly members: readonly { readonly heroName: string; readonly className: string | null; readonly ready: boolean; readonly isYou: boolean }[];
  readonly heroChoices: readonly { readonly id: string; readonly name: string; readonly className: string; readonly available: boolean }[];
}

export type ActivityGameView = ActivityLobbyView | ActivityTableView;

export function buildActivityLobbyView(record: CampaignRecord, bible: AdventureBible, userId: UserId, heroes: readonly { readonly id: string; readonly name: string; readonly class: string }[]): ActivityLobbyView {
  const ownMember = record.lobby.members.find((member) => member.userId === userId && member.status !== "withdrawn");
  const takenIds = new Set(record.lobby.members.flatMap((member) => member.status !== "withdrawn" && member.heroId !== null && member.userId !== userId ? [member.heroId] : []));
  const selectedPreset = heroes.find((hero) => hero.id === ownMember?.heroId);
  const selectedName = ownMember?.label?.name ?? selectedPreset?.name ?? null;
  const selectedClass = ownMember?.label?.className ?? selectedPreset?.class ?? null;
  const startProblem = readyToStart(record.lobby);
  return {
    kind: "lobby",
    language: record.language,
    classNames: texts[record.language].campaign.classes,
    campaignId: record.key.campaignId,
    campaignName: record.name,
    adventureTitle: bible.title,
    playerCount: record.lobby.members.filter((member) => member.status !== "withdrawn").length,
    maxPlayers: record.lobby.maxPlayers,
    canStart: record.organizerId === userId && startProblem === null,
    startBlockReason: startProblem === "notEnoughPlayers" || startProblem === "notReady" ? startProblem : null,
    selectedHeroId: ownMember?.heroId ?? null,
    selectedHeroName: selectedName,
    selectedHeroClass: selectedClass,
    members: record.lobby.members.filter((member) => member.status !== "withdrawn").map((member) => {
      const preset = heroes.find((hero) => hero.id === member.heroId);
      return {
        heroName: member.label?.name ?? preset?.name ?? (member.userId === userId ? texts[record.language].activity.lobby.memberChoose : texts[record.language].activity.lobby.memberChoosing),
        className: member.label?.className ?? preset?.class ?? null,
        ready: member.status === "ready",
        isYou: member.userId === userId,
      };
    }),
    heroChoices: heroes.map((hero) => ({ id: hero.id, name: hero.name, className: hero.class, available: !takenIds.has(hero.id) })),
  };
}

export function buildActivityTableView(
  record: CampaignRecord,
  state: CampaignState,
  bible: AdventureBible,
  content: SealedContent,
  glossary: Glossary,
  userId: UserId,
  heroes: readonly { readonly id: string; readonly name: string; readonly class: string }[],
  now: number,
  savedHeroChoices: readonly { readonly id: string; readonly name: string; readonly className: string }[] = [],
): ActivityTableView {
  const panel = buildPanelView(record, state, bible, glossary);
  const names = { state, bible, glossary };
  const member = state.members[userId];
  const ownCharacterId = member?.characterId ?? null;
  const controlledHeroId = actingHero(state, userId);
  const sheet = ownCharacterId === null ? undefined : state.characters[ownCharacterId];
  const heroView = sheet === undefined ? null : buildHeroView(state, sheet, content);
  const scene = findScene(bible, state.sceneId);
  const explore = controlledHeroId === null || panel.mode === "combat"
    ? null
    : ((): ExploreView & { readonly shops: readonly ShopView[] } => {
      const view = buildExploreView(state, bible, content, glossary, controlledHeroId);
      return { ...view, shops: view.npcs.flatMap((npc) => {
        const shop = buildShopView(state, bible, glossary, resolveHouseRules(record.houseRules), controlledHeroId, npc.id);
        return shop === undefined ? [] : [shop];
      }) };
    })();
  const sharedMap = buildMapView(state, bible);
  const journeyMap: Extract<ActivityTableView["map"], { readonly kind: "journey" }> = {
    kind: "journey",
    nodes: sharedMap.nodes.map((node) => ({
      id: node.id,
      title: node.title ?? node.hint ?? "???",
      status: node.state === "current" ? "current" : node.state === "visited" ? "visited" : node.locked ? "locked" : explore?.places.some((place) => place.id === node.id) === true ? "reachable" : "known",
      locked: node.locked,
      deadEnd: node.deadEnd,
      canTravel: state.pendingMove === undefined && panel.mode !== "paused" && panel.mode !== "safety" && panel.mode !== "recovery" && explore?.places.some((place) => place.id === node.id) === true,
      column: node.column,
      row: node.row,
    })),
    routes: sharedMap.edges,
  };
  const roundSubmission = ownCharacterId === null ? undefined : state.round?.submissions[ownCharacterId];
  const joinRequest = record.joinRequests?.[userId];
  const inviteCurrent = joinRequest !== undefined && joinRequest.expiresAt > now;
  const turn = controlledHeroId === null || panel.mode !== "combat"
    ? null
    : buildTurnView(state, content, resolveHouseRules(record.houseRules), names, controlledHeroId);
  const publicParty: ActivityTableView["party"] = buildPartyView(state, content).map((hero) => {
    const partySheet = state.characters[hero.characterId];
    const raceId = partySheet?.race;
    return {
      characterId: hero.characterId,
      name: hero.name,
      className: hero.className,
      raceName: raceId === undefined ? null : glossary.names[raceId] ?? raceId,
      level: hero.level,
      hp: hero.hp,
      maxHp: hero.maxHp,
      armorClass: hero.armorClass,
      presence: hero.presence,
      down: hero.down,
      fallen: hero.fallen,
      conditions: hero.conditions,
      imageUrl: partySheet?.origin === undefined && !hasPicture(record.images?.[`hero:${hero.characterId}`]) ? null : `/api/activity/games/${encodeURIComponent(record.key.campaignId)}/images/characters/${encodeURIComponent(hero.characterId)}`,
      isYou: hero.ownerUserId === userId,
      tableStatus: panel.combat?.party.some((combatant) => combatant.name === hero.name && combatant.active) === true
        ? "acting"
        : state.round?.submissions[hero.characterId]?.kind === "action" ? "submitted"
          : state.round?.submissions[hero.characterId]?.kind === "pass" ? "passed"
            : state.round?.submissions[hero.characterId]?.kind === "missed" ? "missed"
              : state.members[hero.ownerUserId]?.availability === "away" ? "away" : "waiting",
    };
  });
  const fullHero = heroView === null ? null : {
    characterId: heroView.characterId,
    imageUrl: sheet?.origin === undefined && !hasPicture(record.images?.[`hero:${heroView.characterId}`]) ? null : `/api/activity/games/${encodeURIComponent(record.key.campaignId)}/images/characters/${encodeURIComponent(heroView.characterId)}`,
    name: heroView.name,
    className: heroView.className,
    raceName: sheet?.race === undefined ? null : glossary.names[sheet.race] ?? sheet.race,
    level: heroView.level,
    hp: heroView.hp,
    maxHp: heroView.maxHp,
    armorClass: heroView.armorClass,
    gold: heroView.gold,
    partyGold: heroView.partyGold,
    weapons: heroView.weapons.map((id) => glossary.names[id] ?? id),
    worn: heroView.worn.map((id) => glossary.names[id] ?? id),
    pack: heroView.pack.map((item) => ({ ...item, name: glossary.names[item.id] ?? item.id })),
    stash: [...new Set(heroView.stash)].map((id) => ({ id, name: glossary.names[id] ?? id, count: heroView.stash.filter((item) => item === id).length })),
    inventoryChoices: [...new Set([...heroView.weapons, ...heroView.worn, ...heroView.pack.map((item) => item.id)])].map((id) => {
      const definition = content.find(id);
      const wearable = definition?.kind === "item" && (definition.itemType === "armor" || definition.itemType === "shield");
      return { id, name: glossary.names[id] ?? id, count: sheet?.equipment.filter((item) => item === id).length ?? 0, wearable, worn: heroView.worn.includes(id) };
    }),
    usablePotions: heroView.pack.flatMap((item) => {
      const definition = content.find(item.id);
      return definition?.kind === "item" && definition.itemType === "potion"
        ? [{ id: item.id, name: glossary.names[item.id] ?? item.id, count: item.count }]
        : [];
    }),
    cantrips: heroView.cantrips.map((id) => glossary.names[id] ?? id),
    prepared: heroView.prepared.map((id) => glossary.names[id] ?? id),
    slots: heroView.slots,
    pactSlots: heroView.pactSlots,
    uses: heroView.uses.map((use) => ({ ...use, name: glossary.names[use.id] ?? use.id })),
  };
  return {
    kind: "table",
    language: record.language,
    classNames: texts[record.language].campaign.classes,
    campaignId: record.key.campaignId,
    campaignName: record.name,
    adventureTitle: bible.title,
    sceneId: state.sceneId,
    mode: panel.mode,
    ownPresence: state.members[userId]?.availability ?? "away",
    roundNumber: panel.roundNumber,
    mapText: texts[record.language].campaign.map,
    // Show the encounter illustration during combat when it is ready; otherwise
    // keep the scene art visible. When combat ends, this naturally returns to scene art.
    scene: {
      title: panel.sceneTitle,
      description: scene?.publicDescription ?? "",
      imageUrl: panel.combat !== null && hasPicture(record.images?.[`encounter:${panel.combat.encounterId}`])
        ? `/api/activity/games/${encodeURIComponent(record.key.campaignId)}/images/encounters/${encodeURIComponent(panel.combat.encounterId)}`
        : scene === undefined ? null : `/api/activity/games/${encodeURIComponent(record.key.campaignId)}/images/scenes/${encodeURIComponent(scene.id)}`,
    },
    pendingMove: state.pendingMove === undefined ? null : {
      sceneId: state.pendingMove.sceneId,
      present: presentMembers(state).length,
      needed: Math.ceil(presentMembers(state).length / 2),
      closesAt: state.round?.closesAt ?? null,
      sceneTitle: findScene(bible, state.pendingMove.sceneId)?.title ?? state.pendingMove.sceneId,
      sceneDescription: findScene(bible, state.pendingMove.sceneId)?.publicDescription ?? "",
      proposedBy: state.pendingMove.proposedBy === undefined
        ? state.pendingMove.heroes?.flatMap((id) => state.characters[id]?.name ?? []).join(", ") || null
        : (() => {
          const proposer = state.members[state.pendingMove!.proposedBy!];
          const characterId = proposer?.characterId;
          return characterId == null ? null : state.characters[characterId]?.name ?? characterId;
        })(),
      supporters: (state.pendingMove.supporters ?? []).flatMap((supporter) => {
        const characterId = state.members[supporter]?.characterId;
        return characterId == null ? [] : [state.characters[characterId]?.name ?? characterId];
      }),
      staying: state.pendingMove.objectors.flatMap((objector) => {
        const objectorHero = state.members[objector]?.characterId;
        return objectorHero === null || objectorHero === undefined ? [] : [state.characters[objectorHero]?.name ?? objectorHero];
      }),
      choiceByYou: state.pendingMove.objectors.includes(userId) ? "stay" : state.pendingMove.supporters?.includes(userId) ? "go" : null,
    },
    map: panel.combat !== null && state.encounter !== null
      ? {
        kind: "battlefield",
        edges: state.encounter.edges,
        zones: state.encounter.zones.map((zone) => ({
          id: zone.id,
          name: zone.name,
          lighting: zone.lighting ?? null,
          cover: zone.cover ?? null,
          difficult: zone.difficult ?? false,
          canMove: turn?.moves.some((move) => move.zoneId === zone.id) ?? false,
          occupants: [
            ...panel.combat!.party.filter((hero) => hero.zone === zone.name).map((hero) => ({ name: hero.name, side: "party" as const, active: hero.active, hp: hero.hp, maxHp: hero.maxHp })),
            ...panel.combat!.foes.filter((foe) => foe.zone === zone.name).map((foe) => ({ name: foe.name, side: "foes" as const, ...(foe.rank === undefined ? {} : { rank: foe.rank }), active: foe.active, hp: foe.hp, maxHp: foe.maxHp })),
          ],
        })),
      }
      : journeyMap,
    yourTurn: turn !== null,
    canBegin: record.organizerId === userId,
    activeName: panel.combat?.activeName ?? null,
    upcomingNames: panel.combat?.upcoming ?? [],
    party: publicParty,
    foes: panel.combat?.foes ?? [],
    offers: Object.values(state.offers).flatMap((offer) => {
      const from = state.characters[offer.fromCharacterId];
      const to = state.characters[offer.toCharacterId];
      if (from === undefined || to === undefined || (from.ownerUserId !== userId && to.ownerUserId !== userId)) return [];
      return [{ id: offer.id, fromCharacterId: from.id, toCharacterId: to.id, fromName: from.name, toName: to.name, itemName: glossary.names[offer.give] ?? offer.give, direction: from.ownerUserId === userId ? "outgoing" as const : "incoming" as const }];
    }),
    myHero: fullHero,
    turn,
    explore: controlledHeroId === null || state.pendingMove !== undefined || panel.mode !== "collecting"
      ? null
      : explore,
    pendingRoll: panel.pendingRolls.find((roll) => roll.userId === userId) === undefined
      ? null
      : ((): { readonly checkId: string; readonly test: CheckTest; readonly action: string | null } | null => {
        const roll = panel.pendingRolls.find((item) => item.userId === userId)!;
        const check = Object.values(state.checks).find((item) => item.characterId === roll.characterId && (item.status === "pending" || item.status === "rolling"));
        return check === undefined ? null : { checkId: check.id, test: roll.test, action: roll.action };
      })(),
    pendingRollCount: panel.pendingRolls.length,
    rolls: ownCharacterId === null ? [] : recentRolls(state, ownCharacterId),
    submittedCount: state.round == null ? 0 : Object.values(state.round.submissions).filter((submission) => submission.kind === "action" || submission.kind === "pass").length,
    participantCount: state.round?.participants.length ?? 0,
    submission: roundSubmission?.kind === "action" ? "action" : roundSubmission?.kind ?? null,
    submissionText: roundSubmission?.kind === "action" ? roundSubmission.text : null,
    submissionRevision: roundSubmission?.kind === "action" ? roundSubmission.revision : null,
    canAcceptInvite: ownCharacterId === null && inviteCurrent && joinRequest?.status === "invited",
    joinRequestStatus: inviteCurrent ? joinRequest.status : null,
    queuedJoin: inviteCurrent && joinRequest?.status === "queued" && joinRequest.queuedHero !== undefined
      ? { heroName: joinRequest.queuedHero.name, encounterRound: state.encounter?.round ?? null, nextEncounter: state.pendingEncounter !== null }
      : null,
    joinChoices: ownCharacterId === null && inviteCurrent && joinRequest?.status === "approved"
      ? heroes.flatMap((hero) => Object.values(state.characters).some((existing) => !isFallen(state, existing.id) && (existing.id === hero.id || existing.id.startsWith(`${hero.id}-`)))
        ? []
        : [{ id: hero.id, name: hero.name, className: hero.class }])
      : [],
    savedHeroChoices: ownCharacterId === null && inviteCurrent && joinRequest?.status === "approved"
      ? savedHeroChoices
      : [],
    reaction: buildReactionView(state, bible, glossary),
    reactionIsYours: buildReactionView(state, bible, glossary)?.targetUserId === userId,
    smite: buildSmiteView(state, bible, glossary),
    smiteIsYours: buildSmiteView(state, bible, glossary)?.attackerUserId === userId,
    opportunityAttack: buildOpportunityAttackView(state, bible, glossary),
    opportunityAttackIsYours: buildOpportunityAttackView(state, bible, glossary)?.provokerUserId === userId,
  };
}

export function canSeeActivityCampaign(record: CampaignRecord, state: CampaignState | undefined, userId: UserId, now: number): boolean {
  if (record.visibility !== "membersOnly") return true;
  const participant = record.organizerId === userId
    || record.lobby.members.some((member) => member.userId === userId && member.status !== "withdrawn")
    || state?.members[userId] !== undefined;
  const invite = record.joinRequests?.[userId];
  const invited = invite !== undefined && invite.expiresAt > now && (invite.status === "invited" || invite.status === "approved" || invite.status === "queued");
  return participant || invited;
}

function recentRolls(state: CampaignState, characterId: string) {
  const checks = Object.values(state.checks).filter((check) => check.characterId === characterId && check.result !== null).sort((a, b) => b.roundNumber - a.roundNumber).slice(0, 1)
    .map((check) => ({ id: check.id as string, test: check.test, natural: check.result!.roll.d20.natural, total: check.result!.roll.total, dc: check.dc, success: check.result!.success }));
  const presses = Object.values(state.dialogues).filter((dialogue) => dialogue.characterId === characterId && dialogue.check?.natural !== undefined).slice(-1)
    .map((dialogue) => ({ id: dialogue.id, test: dialogue.check!.test, natural: dialogue.check!.natural!, total: dialogue.check!.total, dc: dialogue.check!.dc, success: dialogue.check!.success }));
  return [...checks, ...presses];
}
