import { wildShapeUses } from "../rules/wild-shape-rules.js";
import { featureUsesOf, traitsOf } from "../rules/content-definitions.js";
import { innateUseKey } from "../rules/traits.js";
import { defaultHeroResources, type HeroStatus } from "../character/hero-status.js";
import type { CharacterId } from "../core/ids.js";
import { isFallen } from "../state/campaign-state.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";

// Rests restore limited resources between fights (2014 rules). Short:
// features that recharge on a short rest; the heroes then spend Hit Dice
// themselves, each one rolled (engine/hit-dice.ts). Long: HP,
// spell slots, every feature, and half the Hit Dice back (at least one).
// What a scene may attach to a long rest, in the shape the engine applies.
type StoryEffect = Parameters<Decision["applyStory"]>[1];

export function takeRest(decision: Decision, rest: "short" | "long", story: readonly StoryEffect[] = []): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind === "user" && ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (state.encounter !== null && state.encounter.status !== "ended") return { code: "inCombat" };
  if (state.round !== null) return { code: "roundInProgress" };
  // What a scene attaches to a long rest is only ever a line, a clue, a flag, a reward or a keepsake; a short rest attaches nothing.
  const allowed = new Set<StoryEffect["kind"]>(["notice", "revealClue", "setFlag", "grantReward", "grantKeepsake"]);
  const stray = story.filter((effect) => !allowed.has(effect.kind));
  if (stray.length > 0 || (rest === "short" && story.length > 0)) return { code: "invalidPlan", problems: ["A rest can only bring lines, clues, flags, rewards and keepsakes."] };
  performRest(decision, rest, story);
  return null;
}

// The organizer asks for a rest. Taken at once when nothing is going; otherwise kept until the round or fight in progress is over,
// and taken just before the next round would open (openRound). rest null takes the request back.
export function queueRest(decision: Decision, rest: "short" | "long" | null, story: readonly StoryEffect[] = []): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind === "user" && ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (rest === null) {
    if (state.pendingRest !== undefined) decision.emit({ kind: "restQueued", rest: null });
    return null;
  }
  if (state.status !== "active" && state.status !== "waitingForPlayers") return { code: "nothingToRest" };
  const idle = state.round === null && (state.encounter === null || state.encounter.status === "ended");
  if (idle) return takeRest(decision, rest, story);
  const allowed = new Set<StoryEffect["kind"]>(["notice", "revealClue", "setFlag", "grantReward", "grantKeepsake"]);
  if (story.some((effect) => !allowed.has(effect.kind)) || (rest === "short" && story.length > 0)) return { code: "invalidPlan", problems: ["A rest can only bring lines, clues, flags, rewards and keepsakes."] };
  decision.emit({ kind: "restQueued", rest, sceneId: state.sceneId, story });
  return null;
}

// The queued rest, taken now that nothing is going. Its scene lines count only if the party is still where it was asked.
export function takeQueuedRest(decision: Decision): void {
  const queued = decision.state.pendingRest;
  if (queued === undefined) return;
  performRest(decision, queued.rest, queued.sceneId === decision.state.sceneId ? queued.story : []);
}

function performRest(decision: Decision, rest: "short" | "long", story: readonly StoryEffect[]): void {
  const { state, ctx } = decision;
  const content = ctx.rules.content;
  const heroStatus: Record<CharacterId, HeroStatus> = {};
  for (const sheet of Object.values(state.characters)) {
    if (isFallen(state, sheet.id)) continue;
    const fresh = defaultHeroResources(sheet, content);
    const current = state.heroStatus[sheet.id] ?? { hp: sheet.maxHp, resources: fresh };
    const dice = current.hitDice ?? sheet.level;
    if (rest === "long") {
      const hitDice = Math.min(sheet.level, dice + Math.max(1, Math.floor(sheet.level / 2)));
      // SRD 5.1: a long rest also removes one level of Exhaustion.
      const exhaustion = Math.max(0, (current.exhaustion ?? 0) - 1);
      heroStatus[sheet.id] = { hp: sheet.maxHp, resources: fresh, hitDice, exhaustion };
      continue;
    }
    // Largest die first (hitDicePool's own ordering): a multiclass hero's
    // remaining `dice` count is always the smallest-`dice` suffix of this
    // sorted pool, since every rest spends and restores largest-first too —
    // see hitDicePool's doc comment (character-build.ts).
    // Hit Dice are the hero's to spend after the rest (engine/hit-dice.ts): the rest itself heals nothing.
    const hp = current.hp;
    const left = dice;
    const featureUses = { ...current.resources.featureUses };
    for (const id of sheet.features) {
      const feature = content.find(id);
      const uses = feature?.kind === "feature" ? featureUsesOf(feature, sheet.level) : null;
      if (uses?.recharge === "shortRest") featureUses[id] = uses.count;
      if (feature?.kind === "feature" && feature.traits.some((trait) => trait.kind === "wildShape")) featureUses[id] = wildShapeUses;
    }
    // Sorcerous Restoration (Sorcerer 20): four sorcery points come back on a short rest.
    if (sheet.features.includes("feature:sorcerous-restoration")) {
      const font = "feature:font-of-magic";
      featureUses[font] = Math.min(fresh.featureUses[font] ?? sheet.level, (featureUses[font] ?? 0) + 4);
    }
    // Spell-shaped abilities that come back on a short rest (Breath Weapon).
    const sources = [...(sheet.race === undefined ? [] : [sheet.race]), ...sheet.features];
    for (const trait of sources.flatMap((id) => { const definition = content.find(id); return definition === undefined ? [] : traitsOf(definition); })) {
      if (trait.kind === "featureSpell" && (trait.recharge === "shortRest" || (trait.spell === "spell:bardic-inspiration" && sheet.features.includes("feature:font-of-inspiration")))) delete featureUses[innateUseKey(trait.spell)];
    }
    // Arcane Recovery and Natural Recovery: slots back once a day, up to half the hero's level in combined slot levels, highest first.
    const spellSlots = { ...current.resources.spellSlots };
    for (const id of sheet.features) {
      const feature = content.find(id);
      const recovery = feature?.kind === "feature" ? feature.traits.find((trait) => trait.kind === "slotRecovery") : undefined;
      if (recovery === undefined || (featureUses[recovery.feature] ?? 0) < 1) continue;
      let budget = Math.ceil(sheet.level / 2);
      for (const level of Object.keys(fresh.spellSlots).map(Number).sort((a, b) => b - a)) {
        if (level > 5) continue;
        while (budget >= level && (spellSlots[level] ?? 0) < (fresh.spellSlots[level] ?? 0)) {
          spellSlots[level] = (spellSlots[level] ?? 0) + 1;
          budget -= level;
          featureUses[recovery.feature] = 0;
        }
      }
    }
    // Pact Magic (Warlock) is SRD 5.1's one resource that comes back on a
    // short rest rather than a long one; every other spell slot is
    // untouched here, same as before this hero had any.
    heroStatus[sheet.id] = {
      hp,
      resources: { ...current.resources, spellSlots, featureUses, ...(fresh.pactSlots === undefined ? {} : { pactSlots: fresh.pactSlots }) },
      hitDice: left,
      exhaustion: current.exhaustion ?? 0,
    };
  }
  decision.emit({ kind: "restTaken", rest, heroStatus });
  // Time passes with the rest: a short one is a phase of the day, a long one runs to the next dawn.
  decision.changeWorld(state.lastRoundNumber, { kind: "rest", rest }, "rest");
  for (const effect of story) decision.applyStory(state.lastRoundNumber, effect);
}
