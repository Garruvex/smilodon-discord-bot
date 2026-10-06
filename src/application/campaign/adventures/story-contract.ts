import type { AdventureBible, BibleEffect, BibleInteraction, BibleRequirement, BibleScene } from "../../../domain/campaign/adventure/adventure-bible.js";

import { searchStoryStates } from "./story-states.js";

// The story contract: whatever the table does, and however the dice fall, the story keeps an authored way forward to an ending.
// This is a static check of the adventure's graph. It follows every `requires` and plays the story two ways:
//   optimistic   every attempt succeeds: which scenes, flags and clues can ever come about;
//   pessimistic  nobody guesses anything clever and every roll fails: what still comes about by itself (a no-roll interaction, a
//                failure branch, an exit with no requirement, a fight that is simply won).
// An ending the pessimistic play cannot reach is a story a bad roll can strand, and the report says which gate and who holds the key.

export type FindingSeverity = "error" | "warning";

export interface StoryFinding {
  readonly severity: FindingSeverity;
  // A short stable name, so a guide and a tool can refer to the rule.
  readonly rule: StoryRule;
  readonly message: string;
  // What an author does about it.
  readonly fix: string;
}

export type StoryRule =
  | "no-ending"
  | "unreachable-scene"
  | "dead-end-scene"
  | "unsatisfiable-requirement"
  | "rolled-gate"
  | "ending-stranded";

interface Progress {
  readonly scenes: Set<string>;
  readonly flags: Set<string>;
  readonly clues: Set<string>;
  // What each interaction or fight contributed, so a report can name the holder of a key.
  readonly done: Set<string>;
}

type Mode = "optimistic" | "pessimistic";

// Every effect, with the options of a chance table flattened in (all of them when `all`, none otherwise).
function* effectsOf(effects: readonly BibleEffect[], all: boolean): Generator<Exclude<BibleEffect, { kind: "random" }>> {
  for (const effect of effects) {
    if (effect.kind !== "random") yield effect;
    else if (all) for (const option of effect.options) yield* effectsOf(option.effects, all);
  }
}

const met = (requires: BibleRequirement | undefined, progress: Progress): boolean =>
  requires === undefined || ((requires.flags ?? []).every((flag) => progress.flags.has(flag)) && (requires.clues ?? []).every((clue) => progress.clues.has(clue)));

// The scenes the adventure lets a scene lead to. A scene that lists no exits lets the party go anywhere (the Planner sends them).
const hasRoutes = (bible: AdventureBible): boolean => bible.scenes.some((scene) => scene.exits !== undefined);

// Whether an interaction is certain to apply by itself: no roll, nothing to pay.
// A fallback step happens anyway when the table stalls, so it counts as certain whatever it would otherwise roll or cost.
const certain = (interaction: BibleInteraction): boolean => interaction.fallback === true || (interaction.check === null && interaction.pay === 0);

function apply(bible: AdventureBible, progress: Progress, effects: readonly BibleEffect[], mode: Mode, depth = 0): boolean {
  let changed = false;
  const add = (set: Set<string>, value: string): void => {
    if (!set.has(value)) { set.add(value); changed = true; }
  };
  for (const effect of effectsOf(effects, mode === "optimistic")) {
    switch (effect.kind) {
      case "set": add(progress.flags, effect.flag); break;
      case "reveal": add(progress.clues, effect.clue); break;
      case "goto": add(progress.scenes, effect.scene); break;
      case "encounter": changed = fight(bible, progress, effect.encounter, mode, depth) || changed; break;
      case "clock": {
        // A clock that fills starts its fight; the pessimistic story does not rely on a clock being filled.
        const clock = bible.clocks.find((candidate) => candidate.id === effect.clock);
        if (mode === "optimistic" && clock?.onFull !== null && clock?.onFull !== undefined) changed = fight(bible, progress, clock.onFull, mode, depth) || changed;
        break;
      }
      default: break;
    }
  }
  return changed;
}

// A fight is won in the optimistic play (its truce and victory effects follow) and lost in the pessimistic one (only its onDefeat effects follow).
function fight(bible: AdventureBible, progress: Progress, encounterId: string, mode: Mode, depth: number): boolean {
  const key = `fight:${encounterId}`;
  if (progress.done.has(key) || depth > 8) return false;
  progress.done.add(key);
  const encounter = bible.encounters.find((candidate) => candidate.id === encounterId);
  if (encounter === undefined) return true;
  const trigger = (encounter.triggers ?? []).flatMap((entry) => entry.effects.filter((effect) => effect.kind !== "add" && effect.kind !== "end" && effect.kind !== "announce"));
  apply(bible, progress, (mode === "optimistic" ? [...trigger, ...(encounter.onVictory ?? [])] : (encounter.onDefeat ?? [])) as readonly BibleEffect[], mode, depth + 1);
  return true;
}

function play(bible: AdventureBible, mode: Mode): Progress {
  const progress: Progress = { scenes: new Set([bible.startScene]), flags: new Set(), clues: new Set(), done: new Set() };
  const routed = hasRoutes(bible);
  for (let changed = true; changed; ) {
    changed = false;
    for (const scene of bible.scenes) {
      if (!progress.scenes.has(scene.id)) continue;
      if (!progress.done.has(`enter:${scene.id}`)) {
        progress.done.add(`enter:${scene.id}`);
        apply(bible, progress, scene.onEnter ?? [], mode);
        // Whoever is here tells what they tell to anyone who asks: a way to a clue that needs no roll.
        for (const npcId of scene.npcIds) for (const tell of bible.npcs.find((npc) => npc.id === npcId)?.tells ?? []) progress.clues.add(tell.clue);
        changed = true;
      }
      // A scheduled fight breaks out on its own once the party is here and its requirement holds; time of day and rounds are met by waiting.
      for (const encounter of bible.encounters) {
        if (encounter.sceneId === scene.id && encounter.schedule !== undefined && met(encounter.schedule.requires, progress) && !progress.done.has(`fight:${encounter.id}`)) {
          fight(bible, progress, encounter.id, mode, 0);
          changed = true;
        }
      }
      // Exits: only those whose requirements hold; no exits listed means anywhere.
      const targets = scene.exits === undefined ? (routed ? [] : bible.scenes.map((other) => other.id as string)) : scene.exits.filter((exit) => met(exit.requires, progress)).map((exit) => exit.to as string);
      for (const target of targets) if (!progress.scenes.has(target)) { progress.scenes.add(target); changed = true; }
      for (const interaction of bible.interactions ?? []) {
        if (interaction.sceneId !== scene.id || progress.done.has(`i:${interaction.id}`) || !met(interaction.requires, progress)) continue;
        // Pessimistic: a rolled or paid interaction fails, so only its failure branch lands; a certain one lands in full.
        const effects = mode === "optimistic" ? [...interaction.onSuccess, ...interaction.tiers.flatMap((tier) => tier.effects)] : certain(interaction) ? interaction.onSuccess : interaction.onFailure;
        progress.done.add(`i:${interaction.id}`);
        apply(bible, progress, effects, mode);
        changed = true;
      }
    }
    // Chance in the optimistic play can also lead on from an exit-less scene, so nothing further is needed here.
  }
  return progress;
}

// Everything in the adventure that sets a flag or reveals a clue, by effect holder, for naming who holds a key.
function holders(bible: AdventureBible): { readonly flags: Map<string, string[]>; readonly clues: Map<string, string[]> } {
  const flags = new Map<string, string[]>();
  const clues = new Map<string, string[]>();
  const note = (map: Map<string, string[]>, key: string, who: string): void => { map.set(key, [...(map.get(key) ?? []), who]); };
  const scan = (effects: readonly BibleEffect[], who: string): void => {
    for (const effect of effectsOf(effects, true)) {
      if (effect.kind === "set") note(flags, effect.flag, who);
      else if (effect.kind === "reveal") note(clues, effect.clue, who);
    }
  };
  for (const scene of bible.scenes) scan(scene.onEnter ?? [], scene.id);
  for (const npc of bible.npcs) for (const tell of npc.tells ?? []) note(clues, tell.clue, npc.id);
  for (const interaction of bible.interactions ?? []) scan([...interaction.onSuccess, ...interaction.onFailure, ...interaction.tiers.flatMap((tier) => tier.effects)], interaction.id);
  for (const encounter of bible.encounters) {
    scan(encounter.onVictory ?? [], encounter.id);
    scan(encounter.onDefeat ?? [], encounter.id);
    for (const trigger of encounter.triggers ?? []) scan(trigger.effects.filter((effect) => effect.kind !== "add" && effect.kind !== "end" && effect.kind !== "announce") as readonly BibleEffect[], encounter.id);
  }
  return { flags, clues };
}

// The ways a scene counts as an ending: marked so, or (when nothing is marked) a scene with no way on at all that is not the start.
function endingScenes(bible: AdventureBible): readonly BibleScene[] {
  const marked = bible.scenes.filter((scene) => scene.ending === true);
  if (marked.length > 0) return marked;
  return bible.scenes.filter((scene) => scene.id !== bible.startScene && scene.exits === undefined && hasRoutes(bible));
}

export function analyzeStoryContract(bible: AdventureBible): readonly StoryFinding[] {
  const findings: StoryFinding[] = [];
  const found = (finding: StoryFinding): void => { findings.push(finding); };
  const endings = endingScenes(bible);
  const optimistic = play(bible, "optimistic");
  const pessimistic = play(bible, "pessimistic");
  const who = holders(bible);
  const gating = { flags: new Set<string>(), clues: new Set<string>() };
  const gate = (requires: BibleRequirement | undefined): void => {
    for (const flag of requires?.flags ?? []) gating.flags.add(flag);
    for (const clue of requires?.clues ?? []) gating.clues.add(clue);
  };
  for (const scene of bible.scenes) for (const exit of scene.exits ?? []) gate(exit.requires);
  for (const interaction of bible.interactions ?? []) gate(interaction.requires);

  // A requirement that nothing in the adventure can ever satisfy.
  const checkRequires = (requires: BibleRequirement | undefined, where: string): void => {
    for (const flag of requires?.flags ?? []) {
      if (!who.flags.has(flag)) found({ severity: "error", rule: "unsatisfiable-requirement", message: `${where} needs flag "${flag}", but nothing in the adventure ever sets it.`, fix: `Set "${flag}" from an interaction, an arrival (onEnter) or a fight result, or remove the requirement.` });
    }
    for (const clue of requires?.clues ?? []) {
      if (!who.clues.has(clue)) found({ severity: "error", rule: "unsatisfiable-requirement", message: `${where} needs clue "${clue}", but nothing in the adventure ever reveals it.`, fix: `Reveal "${clue}" from an interaction or an arrival (onEnter), or remove the requirement.` });
    }
  };
  for (const scene of bible.scenes) for (const exit of scene.exits ?? []) checkRequires(exit.requires, `The exit ${scene.id} -> ${exit.to}`);
  for (const interaction of bible.interactions ?? []) checkRequires(interaction.requires, interaction.id);

  if (hasRoutes(bible)) {
    if (endings.length === 0) found({ severity: "warning", rule: "no-ending", message: "The adventure marks no ending scene, so a way to finish cannot be checked.", fix: "Mark each final scene with ending: true." });
    for (const scene of bible.scenes) {
      if (!optimistic.scenes.has(scene.id)) found({ severity: "error", rule: "unreachable-scene", message: `${scene.id} cannot be reached by any route, even when every attempt succeeds.`, fix: "Add an exit or a goto that leads there, or remove the scene." });
      else if (scene.exits?.length === 0 && scene.ending !== true && !(bible.interactions ?? []).some((interaction) => interaction.sceneId === scene.id && interaction.onSuccess.some((effect) => effect.kind === "goto"))) {
        found({ severity: "error", rule: "dead-end-scene", message: `${scene.id} has no way out and is not an ending; the party would be stuck there.`, fix: "Give it an exit, or mark it ending: true." });
      }
    }
    // The pessimistic story: every roll fails. What still reaches an ending?
    // The story must always be able to finish: one ending (a floor ending, however poor) that bad luck cannot close is enough. The good endings may need success.
    const reachableEndings = endings.filter((scene) => optimistic.scenes.has(scene.id));
    // The full check: every state the story can reach, each played against chance. Only when the adventure is too large to search does the
    // coarser check below (one merged pessimistic play) stand in for it.
    const search = endings.length > 0 ? searchStoryStates(bible, endings.map((scene) => scene.id)) : undefined;
    if (search?.kind === "complete") {
      const seen = new Set<string>();
      for (const { state, path } of search.stranded) {
        if (seen.has(state.scene) || seen.size >= 3) continue;
        seen.add(state.scene);
        const holding = [...[...state.flags].filter(([, value]) => value > 0).map(([flag]) => `flag "${flag}"`), ...[...state.clues].map((clue) => `clue "${clue}"`)];
        found({
          severity: "error",
          rule: "ending-stranded",
          message: `A table can be stranded in ${state.scene}: from there, once rolls fail and fights are lost, no choice still leads to an ending. One way in: ${path.join(" → ")}.${holding.length === 0 ? "" : ` The party then holds ${holding.join(", ")}.`}`,
          fix: "From that point, give the story a way on that needs no roll: an exit with no requirement (or one a no-roll interaction opens), an NPC tell or arrival effect for the clue it needs, an onFailure or onDefeat that still moves the story, a fallback step, or a floor ending.",
        });
      }
    } else if (search?.kind === "tooLarge") {
      found({ severity: "warning", rule: "ending-stranded", message: `The adventure has too many story states to check one by one (gave up after ${search.states}); only the coarse check was made.`, fix: "Split the adventure, or use fewer flags that only matter together." });
    }
    const finishesAnyway = search?.kind === "complete" || reachableEndings.some((scene) => pessimistic.scenes.has(scene.id));
    for (const ending of finishesAnyway ? [] : reachableEndings) {
      if (pessimistic.scenes.has(ending.id)) continue;
      // Only what something actually requires is a gate; a flag nobody reads is not why the way is shut.
      const missingFlags = [...optimistic.flags].filter((flag) => !pessimistic.flags.has(flag) && gating.flags.has(flag));
      const missingClues = [...optimistic.clues].filter((clue) => !pessimistic.clues.has(clue) && gating.clues.has(clue));
      const blockers = [
        ...missingFlags.map((flag) => `flag "${flag}" (only from ${(who.flags.get(flag) ?? []).join(", ")})`),
        ...missingClues.map((clue) => `clue "${clue}" (only from ${(who.clues.get(clue) ?? []).join(", ")})`),
      ];
      found({
        severity: "error",
        rule: "ending-stranded",
        message: `No ending can be reached when the rolls go badly (${ending.id} is shut): nothing automatic leads there. Out of reach: ${blockers.join("; ") || "a route that needs a successful roll"}.`,
        fix: "Add a floor ending that bad luck cannot close (a scene marked ending: true that something automatic leads to), or give each of those a way that needs no roll (an automatic interaction, an NPC tell or an arrival effect), a failure branch (onFailure) that still moves the story on, a fallback step, or, for a fight, an onDefeat that lets the story go on at a cost.",
      });
    }
    for (const interaction of bible.interactions ?? []) {
      // A gate someone must roll for, with nothing to catch a failure: attempts used up and the gate stays shut.
      if (certain(interaction) || interaction.onFailure.length > 0 || interaction.attempts > 1) continue;
      const gives = new Set<string>();
      for (const effect of effectsOf(interaction.onSuccess, true)) {
        if (effect.kind === "set") gives.add(`flag ${effect.flag}`);
        else if (effect.kind === "reveal") gives.add(`clue ${effect.clue}`);
        else if (effect.kind === "goto") gives.add(`the way to ${effect.scene}`);
        else if (effect.kind === "encounter") gives.add(`the fight ${effect.encounter}`);
      }
      // Something another interaction (or an arrival) gives without a roll is not decided by this one.
      const elsewhere = new Set<string>();
      const give = (effects: readonly BibleEffect[]): void => {
        for (const effect of effectsOf(effects, true)) {
          if (effect.kind === "set") elsewhere.add(`flag ${effect.flag}`);
          else if (effect.kind === "reveal") elsewhere.add(`clue ${effect.clue}`);
          else if (effect.kind === "goto") elsewhere.add(`the way to ${effect.scene}`);
          else if (effect.kind === "encounter") elsewhere.add(`the fight ${effect.encounter}`);
        }
      };
      for (const other of bible.interactions ?? []) if (other.id !== interaction.id && certain(other)) give(other.onSuccess);
      for (const place of bible.scenes) give(place.onEnter ?? []);
      const needed = [...gives].filter((item) => !elsewhere.has(item)).filter((item) => {
        const [kind, id] = [item.split(" ")[0], item.slice(item.indexOf(" ") + 1)];
        if (kind === "flag") return bible.scenes.some((scene) => (scene.exits ?? []).some((exit) => (exit.requires?.flags ?? []).includes(id))) || (bible.interactions ?? []).some((other) => (other.requires.flags ?? []).includes(id));
        if (kind === "clue") return (bible.interactions ?? []).some((other) => (other.requires.clues ?? []).includes(id as `clue:${string}`)) || bible.scenes.some((scene) => (scene.exits ?? []).some((exit) => (exit.requires?.clues ?? []).includes(id as `clue:${string}`)));
        return true;
      });
      if (needed.length > 0 && !(gives.size === 0)) {
        found({ severity: "warning", rule: "rolled-gate", message: `${interaction.id} is a single roll (DC ${interaction.check?.dc ?? "?"}${interaction.pay > 0 ? `, costs ${interaction.pay} gold` : ""}) that decides ${needed.join(", ")}, with no failure branch and one attempt.`, fix: "Allow more attempts, add an onFailure that still moves the story on, or give another way to the same result." });
      }
    }
  }
  return findings;
}
