import type { EncounterMonster, EncounterSpec, EncounterTrigger, FightEffect, PartyEffect } from "../commands/campaign-command.js";
import type { ContentId } from "../rules/content-id.js";
import type { Ability, DamageType } from "../rules/effects.js";
import type { TimeOfDay, Weather } from "../rules/world-rules.js";

// The adventure as authored (plan §6, layer B). Fields are split by who may
// see them: public fields can reach narration; dmOverview, dmNotes, and
// secrets go only to the Planner and never to the Narrator.
export type CampaignLanguage = "en" | "zh-TW";

export type SceneId = `scene:${string}`;
export type NpcId = `npc:${string}`;
export type EncounterId = `encounter:${string}`;
export type ClockId = `clock:${string}`;
export type ClueId = `clue:${string}`;
export type InteractionId = `interaction:${string}`;

export interface AdventureBible {
  readonly id: string;
  readonly version: string;
  readonly language: CampaignLanguage;
  readonly title: string;
  readonly premise: string;
  // The level the adventure is written for. Absent: level 1. The table's
  // starting-level rule can override it; everyone is brought up to the result.
  readonly startingLevel?: number;
  // The party this adventure is written for. Fights are tuned for `min` heroes and grow tougher in proportion to every hero beyond that; `max` is the most the story is written for.
  readonly suggestedParty?: { readonly min: number; readonly max: number };
  readonly dmOverview: string;
  readonly startScene: SceneId;
  // The story only moves forward on purpose (a train, a dream, a descent): one-way exits are not reported as mistakes.
  readonly linear?: boolean;
  // When the story begins: day (1 if not given), time of day and weather. Absent: the adventure keeps no clock and nobody invents one.
  readonly startTime?: { readonly day?: number; readonly time: TimeOfDay; readonly weather?: Weather };
  readonly scenes: readonly BibleScene[];
  readonly npcs: readonly BibleNpc[];
  readonly encounters: readonly BibleEncounter[];
  readonly clocks: readonly BibleClock[];
  readonly clues: readonly BibleClue[];
  // What the party can do in each scene, as the engine plays it (see BibleInteraction). Absent: the Planner improvises from the notes alone.
  readonly interactions?: readonly BibleInteraction[];
}

// What the engine can do when a story beat lands. The same few words serve every scene, check and fight, so an adventure is data and
// never code: the Planner picks which interaction the players are attempting, and the engine rolls it and applies these.
export type BiblePartyEffect =
  | { readonly kind: "reveal"; readonly clue: ClueId }
  // Sets a story flag (value 1 unless given) that interactions and exits can require.
  | { readonly kind: "set"; readonly flag: string; readonly value?: number }
  | { readonly kind: "reward"; readonly gold?: number; readonly items?: readonly ContentId<"item">[] }
  | { readonly kind: "goto"; readonly scene: SceneId }
  | { readonly kind: "encounter"; readonly encounter: EncounterId }
  | { readonly kind: "clock"; readonly clock: ClockId; readonly by: number }
  // A line the table sees, once (the same words are never shown twice).
  | { readonly kind: "notice"; readonly text: string }
  // A story object the party now carries, with the name and words the table knows it by.
  | { readonly kind: "keepsake"; readonly id: string; readonly name: string; readonly description: string }
  // Time passes in the story by phases of the day (six make a day); the sky changes. Only when the adventure has a clock (startTime).
  | { readonly kind: "time"; readonly advance: number }
  | { readonly kind: "weather"; readonly weather: Weather };

// Harm between fights, rolled by the dice: to the heroes the effect follows (rollers, the default: each hero who took the attempt and
// whose result it hangs on) or to the whole party.
export interface BibleHurt {
  readonly kind: "hurt";
  readonly count: number;
  readonly sides: 4 | 6 | 8 | 10 | 12;
  readonly damageType: DamageType;
  readonly who?: "rollers" | "party";
}

// One of several outcomes picked at random when the round is planned (a table on the page: d6, d100). Weights default to 1.
export interface BibleRandom {
  readonly kind: "random";
  readonly options: readonly { readonly weight?: number; readonly effects: readonly (BiblePartyEffect | BibleHurt)[] }[];
}

export type BibleEffect = BiblePartyEffect | BibleHurt | BibleRandom;

// What must hold before an interaction or an exit is available. Every listed condition must hold.
export interface BibleRequirement {
  readonly clues?: readonly ClueId[];
  // Story flags that must be set, and flags that must not be.
  readonly flags?: readonly string[];
  readonly notFlags?: readonly string[];
}

// Something the players can attempt in a scene: an authored check (or none) and what follows. The label says what the players are doing
// in plain words, and the notes tell the Planner when it applies; neither reaches the Narrator.
export interface BibleInteraction {
  readonly id: InteractionId;
  readonly sceneId: SceneId;
  readonly label: string;
  readonly dmNotes: string;
  // Absent: it happens on its own (talking to someone who is willing, taking what is offered).
  // save: a saving throw of that ability (with proficiency where the hero has it) rather than an ability check.
  readonly check: { readonly skill?: string; readonly ability?: Ability; readonly dc: number; readonly save?: boolean } | null;
  readonly requires: BibleRequirement;
  // Gold the hero pays for it; they must have it.
  readonly pay: number;
  // How many times the party may try it (normal play: once, unless the situation changes).
  readonly attempts: number;
  readonly onSuccess: readonly BibleEffect[];
  readonly onFailure: readonly BibleEffect[];
  // Extra results for a roll that reaches a higher total; each tier's effects join the success ones. Ascending by dc.
  readonly tiers: readonly { readonly dc: number; readonly effects: readonly BibleEffect[] }[];
  // If the table stalls (rounds pass and the story does not move), the engine may take this step for them, with no roll and no fee. Only an
  // adventure can authorize that, so nobody is moved against what the story established.
  readonly fallback?: boolean;
}

export const interactionsOf = (bible: AdventureBible): readonly BibleInteraction[] => bible.interactions ?? [];

// A skill-challenge clock (plan §5): the Planner advances it when failure or
// noise costs the party time; when it fills, the authored fight begins.
export interface BibleClock {
  readonly id: ClockId;
  readonly sceneId: SceneId;
  readonly name: string;
  readonly segments: number;
  // When and why to advance it; Planner only.
  readonly dmNotes: string;
  readonly onFull: EncounterId | null;
}

// Something the party can learn. The public text may reach narration once
// the clue is revealed; the notes say when to reveal it.
export interface BibleClue {
  readonly id: ClueId;
  readonly sceneId: SceneId;
  readonly publicText: string;
  readonly dmNotes: string;
}

export interface BibleScene {
  readonly id: SceneId;
  readonly title: string;
  readonly publicDescription: string;
  readonly dmNotes: string;
  // More of what the table can learn here (what is engraved, what the room says about the people who left): the Narrator may use it, so it holds nothing secret.
  readonly details?: string;
  // NPCs present in the scene.
  readonly npcIds: readonly NpcId[];
  // Where the party can go from here. Absent: anywhere the Planner sends them.
  // hidden: the map does not show this way until the party has used it (a secret door). hint: what the map says about a place not yet
  // visited, instead of "???" ("A path north"); it must give nothing away.
  readonly exits?: readonly { readonly to: SceneId; readonly requires?: BibleRequirement; readonly hidden?: boolean; readonly hint?: string }[];
  // What happens whenever the party arrives here by any route: clues, flags, rewards, notices, keepsakes (each lands only once).
  readonly onEnter?: readonly Exclude<BiblePartyEffect, { readonly kind: "goto" | "encounter" | "clock" }>[];
  // The story can end here. Every adventure that lists exits marks its final scenes, so the story contract can check the way to one stays open.
  readonly ending?: boolean;
  // What happens when the party takes a long rest here: the same kinds as onEnter.
  readonly onLongRest?: readonly Exclude<BiblePartyEffect, { readonly kind: "goto" | "encounter" | "clock" }>[];
}

export interface BibleNpc {
  readonly id: NpcId;
  readonly name: string;
  // How the NPC talks, so narration keeps a consistent voice.
  readonly voice: string;
  readonly publicDescription: string;
  readonly secret: string;
  // What this NPC will tell, each telling a clue the party then knows. Asking the NPC reveals the clue when the question names one of the topics
  // (words, in any language the adventure is written in); a tell without topics is given to any question. This is the free, no-roll way to learn it.
  readonly tells?: readonly { readonly clue: ClueId; readonly topics?: readonly string[] }[];
  // Present when this NPC trades. Prices are gold, authored (items carry no
  // inherent value of their own — engine/shop.ts's buyItem/sellItem/hagglePrice
  // never invent one). sellPrice absent means this NPC won't buy that item back.
  readonly shop?: { readonly stock: readonly ShopStock[] };
}

export interface ShopStock {
  readonly itemId: ContentId<"item">;
  readonly buyPrice: number;
  readonly sellPrice?: number;
}

// An authored fight. The Planner may start it by ID (plan §6, "start
// encounter ID"); the map and roster come from here, never from the model.
export interface BibleEncounter {
  readonly id: EncounterId;
  readonly sceneId: SceneId;
  // What the table sees as the fight breaks out.
  readonly publicDescription: string;
  // When to start it; Planner only.
  readonly dmNotes: string;
  readonly zones: readonly { readonly id: string; readonly name: string }[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly feet: number }[];
  readonly partyZoneId: string;
  readonly monsters: readonly EncounterMonster[];
  // Found by the party on a victory.
  readonly loot: readonly ContentId<"item">[];
  readonly gold: number;
  // Winning this fight is a story milestone: at a milestone table the party is
  // raised to this level. An experience table ignores it.
  readonly milestoneLevel?: number;
  // Foes who join when the party is bigger than the adventure's suggested minimum: two from this list (in turn) for each extra hero.
  readonly reinforcements?: readonly EncounterMonster[];
  // Beats inside the fight, each once: foes that arrive, a truce, story effects, a line for the table.
  readonly triggers?: readonly BibleTrigger[];
  // Story effects when the party wins (a fight never starts another fight).
  readonly onVictory?: readonly BiblePartyEffect[];
  // Story effects when the party loses it. A lost fight must still leave the story a way on: set the flag that lets the story go forward at a cost,
  // or move the party somewhere (captured, left for dead). Without it nothing authored happens when the party loses.
  readonly onDefeat?: readonly BiblePartyEffect[];
  // Which side is taken by surprise (the story says so outright). Absent: nobody, unless the ambush below catches the party.
  readonly surprised?: "party" | "foes";
  // The fight breaks out by itself when all of this holds, on a round where the party acts: they are in this scene, the requirement is met,
  // it is that time of day (needs a start time), and they have spent that many rounds here. Without it the fight starts only when an
  // interaction or the Planner starts it. Use it for what happens on its own ("at midnight the scarecrow rises").
  readonly schedule?: { readonly requires?: BibleRequirement; readonly time?: TimeOfDay; readonly afterRounds?: number };
  // The foes lie in wait: unless some hero's passive Perception reaches this, the party starts the fight surprised.
  readonly ambush?: { readonly dc: number };
  // Something dreadful as the fight breaks out: each hero saves (their own bonus), and one who fails is frightened until their first turn ends.
  readonly dread?: { readonly ability: Ability; readonly dc: number };
}

export type BibleFightEffect =
  | Exclude<BiblePartyEffect, { readonly kind: "encounter" }>
  // Foes join the fight, in zones the encounter has.
  | { readonly kind: "add"; readonly monsters: readonly EncounterMonster[] }
  // The rest of the foes stand down: the fight ends in the party's favour, and the victory effects follow.
  | { readonly kind: "end" }
  // A line the table sees as the trigger fires.
  | { readonly kind: "announce"; readonly text: string };

export interface BibleTrigger {
  readonly when: { readonly kind: "foesDown"; readonly count: number } | { readonly kind: "round"; readonly round: number };
  readonly effects: readonly BibleFightEffect[];
}

export function findScene(bible: AdventureBible, sceneId: string | null): BibleScene | undefined {
  return bible.scenes.find((scene) => scene.id === sceneId);
}

export function findEncounter(bible: AdventureBible, encounterId: string | null): BibleEncounter | undefined {
  return bible.encounters.find((encounter) => encounter.id === encounterId);
}

export function findNpc(bible: AdventureBible, npcId: string): BibleNpc | undefined {
  return bible.npcs.find((npc) => npc.id === npcId);
}

export function findClock(bible: AdventureBible, clockId: string): BibleClock | undefined {
  return bible.clocks.find((clock) => clock.id === clockId);
}

export function findClue(bible: AdventureBible, clueId: string): BibleClue | undefined {
  return bible.clues.find((clue) => clue.id === clueId);
}

// An authored effect as the engine applies it. Null for what a fight cannot do (start another fight).
export function storyEffectOf(effect: BiblePartyEffect, rewardId: string, bible?: AdventureBible): PartyEffect | null {
  switch (effect.kind) {
    case "reveal":
      return { kind: "revealClue", clueId: effect.clue, text: bible?.clues.find((clue) => clue.id === effect.clue)?.publicText ?? effect.clue };
    case "set":
      return { kind: "setFlag", flag: effect.flag, value: effect.value ?? 1 };
    case "reward":
      return { kind: "grantReward", rewardId, gold: effect.gold ?? 0, items: effect.items ?? [] };
    case "goto":
      return { kind: "transitionScene", sceneId: effect.scene };
    case "clock":
      return { kind: "advanceClock", clockId: effect.clock, segments: bible?.clocks.find((clock) => clock.id === effect.clock)?.segments ?? 2, by: effect.by, onFull: null };
    case "notice":
      return { kind: "notice", noticeId: rewardId, text: effect.text };
    case "keepsake":
      return { kind: "grantKeepsake", keepsake: { id: effect.id, name: effect.name, description: effect.description } };
    case "time":
      return { kind: "advanceTime", steps: effect.advance };
    case "weather":
      return { kind: "setWeather", weather: effect.weather };
    case "encounter":
      return null;
  }
}

// What happens on arriving in a scene, as engine effects.
export function enterEffects(bible: AdventureBible | undefined, sceneId: string): readonly PartyEffect[] {
  const scene = bible?.scenes.find((candidate) => candidate.id === sceneId);
  return (scene?.onEnter ?? []).flatMap((effect, position) => storyEffectOf(effect, `${sceneId}:enter:${position}`, bible) ?? []);
}

// What a long rest in a scene brings, as engine effects.
export function longRestEffects(bible: AdventureBible | undefined, sceneId: string | null): readonly PartyEffect[] {
  const scene = sceneId === null ? undefined : bible?.scenes.find((candidate) => candidate.id === sceneId);
  return (scene?.onLongRest ?? []).flatMap((effect, position) => storyEffectOf(effect, `${sceneId}:rest:${position}`, bible) ?? []);
}

// A move to a scene brings that scene's arrival effects with it.
export function withArrival(effect: PartyEffect | null, bible: AdventureBible | undefined): readonly PartyEffect[] {
  if (effect === null) return [];
  return effect.kind === "transitionScene" ? [effect, ...enterEffects(bible, effect.sceneId)] : [effect];
}

function fightEffectsOf(effect: BibleFightEffect, rewardId: string, bible?: AdventureBible): readonly FightEffect[] {
  switch (effect.kind) {
    case "add":
      return [{ kind: "addMonsters", monsters: effect.monsters }];
    case "end":
      return [{ kind: "endFight" }];
    case "announce":
      return [{ kind: "announce", text: effect.text }];
    default:
      return withArrival(storyEffectOf(effect, rewardId, bible), bible).flatMap((each) => (each.kind === "startEncounter" || each.kind === "advanceClock" ? [] : [each]));
  }
}

export function encounterSpec(encounter: BibleEncounter, bible?: AdventureBible): EncounterSpec {
  const { id, zones, edges, partyZoneId, monsters, loot, gold, milestoneLevel, ambush, dread, surprised, reinforcements } = encounter;
  const triggers: EncounterTrigger[] = (encounter.triggers ?? []).map((trigger, index) => ({
    when: trigger.when,
    effects: trigger.effects.flatMap((effect, position) => fightEffectsOf(effect, `${id}:trigger${index}:${position}`, bible)),
  }));
  const onVictory = (encounter.onVictory ?? []).flatMap((effect, position) => withArrival(storyEffectOf(effect, `${id}:victory:${position}`, bible), bible));
  const onDefeat = (encounter.onDefeat ?? []).flatMap((effect, position) => withArrival(storyEffectOf(effect, `${id}:defeat:${position}`, bible), bible));
  return {
    id,
    zones,
    edges,
    partyZoneId,
    monsters,
    loot,
    gold,
    ...(milestoneLevel === undefined ? {} : { milestoneLevel }),
    ...(bible?.suggestedParty === undefined ? {} : { partyBase: bible.suggestedParty.min }),
    ...(reinforcements === undefined ? {} : { reinforcements }),
    ...(triggers.length === 0 ? {} : { triggers }),
    ...(onVictory.length === 0 ? {} : { onVictory }),
    ...(onDefeat.length === 0 ? {} : { onDefeat }),
    ...(surprised === undefined ? {} : { surprised }),
    ...(ambush === undefined ? {} : { ambush }),
    ...(dread === undefined ? {} : { dread }),
  };
}
