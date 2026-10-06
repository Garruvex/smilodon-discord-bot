import type { AdventureBible, BibleEffect, BibleEncounter, BibleInteraction, BibleRequirement } from "../../../domain/campaign/adventure/adventure-bible.js";

// The story as a game between the table and chance, played over every state the adventure can be in: where the party is, the value of every
// flag, the clues they hold, the tries each interaction has used, the fights already fought and how full each clock is. The table chooses
// what to do; chance decides every roll, every fight and every table on the page. A state is safe when the table can force an ending from it
// whatever chance decides. The contract is that every state the story can reach is safe, so no branch, however it was entered, traps a table.

export interface StoryState {
  readonly scene: string;
  readonly flags: ReadonlyMap<string, number>;
  readonly clues: ReadonlySet<string>;
  readonly tries: ReadonlyMap<string, number>;
  // Interactions that succeeded, fights fought, scenes entered (their arrival effects landed).
  readonly done: ReadonlySet<string>;
  readonly clocks: ReadonlyMap<string, number>;
}

// One choice the table can make, and every way chance can answer it.
interface Move {
  readonly label: string;
  readonly outcomes: readonly { readonly label: string; readonly state: StoryState }[];
}

export interface StrandedState {
  readonly state: StoryState;
  // How the story got there from the start: the shortest sequence of choices and what chance answered.
  readonly path: readonly string[];
}

export type StateSearch =
  | { readonly kind: "complete"; readonly states: number; readonly stranded: readonly StrandedState[] }
  // The adventure has more states than the search may visit; nothing is concluded from it.
  | { readonly kind: "tooLarge"; readonly states: number };

export const maxStates = 100_000;
// The search runs inside the bot, so it gives up after this long rather than hold everything else up (the coarse check stands in).
export const maxSearchMilliseconds = 400;

const flagOn = (state: StoryState, flag: string): boolean => (state.flags.get(flag) ?? 0) > 0;

const met = (requires: BibleRequirement | undefined, state: StoryState): boolean =>
  requires === undefined ||
  ((requires.flags ?? []).every((flag) => flagOn(state, flag)) &&
    (requires.notFlags ?? []).every((flag) => !flagOn(state, flag)) &&
    (requires.clues ?? []).every((clue) => state.clues.has(clue)));

export function stateKey(state: StoryState): string {
  const sorted = <T>(entries: Iterable<T>): T[] => [...entries].sort();
  return JSON.stringify([
    state.scene,
    sorted([...state.flags].filter(([, value]) => value > 0).map(([flag, value]) => `${flag}=${value}`)),
    sorted(state.clues),
    sorted([...state.tries].map(([id, count]) => `${id}=${count}`)),
    sorted(state.done),
    sorted([...state.clocks].map(([id, filled]) => `${id}=${filled}`)),
  ]);
}

// Whether an interaction is certain to happen once chosen: no roll and no fee, or a fallback step the engine takes for a stalled table.
const certain = (interaction: BibleInteraction): boolean => interaction.fallback === true || (interaction.check === null && interaction.pay === 0);

// Every effect, with the options of a chance table flattened in.
function* flat(effects: readonly BibleEffect[]): Generator<BibleEffect> {
  for (const effect of effects) {
    if (effect.kind === "random") for (const option of effect.options) yield* flat(option.effects as readonly BibleEffect[]);
    else yield effect;
  }
}

class Story {
  // Only what something reads can change where the story may go: other flags and clues are left out of a state, and an interaction that
  // touches none of it (nor moves the party, starts a fight or fills a clock that starts one) is not a choice worth searching.
  private readonly flags = new Set<string>();
  private readonly clues = new Set<string>();
  // Flags whose being set can close a way (an exit or an interaction that requires them unset).
  private readonly closing = new Set<string>();
  // Flags something sets back to zero: only these can open again once set.
  private readonly cleared = new Set<string>();

  public constructor(private readonly bible: AdventureBible, private readonly endings: ReadonlySet<string>) {
    // `sets`: the flag the reader itself sets. "Not if x" on an interaction whose only effect that could matter is setting x is how an author
    // says "once": once x is set, by it or by anything else, closing it loses nothing.
    const read = (requires: BibleRequirement | undefined, sets: ReadonlySet<string> = new Set()): void => {
      for (const flag of [...(requires?.flags ?? []), ...(requires?.notFlags ?? [])]) this.flags.add(flag);
      for (const flag of requires?.notFlags ?? []) if (!sets.has(flag)) this.closing.add(flag);
      for (const clue of requires?.clues ?? []) this.clues.add(clue);
    };
    for (const scene of bible.scenes) for (const exit of scene.exits ?? []) read(exit.requires);
    for (const interaction of bible.interactions ?? []) {
      const effects = [...flat([...interaction.onSuccess, ...interaction.tiers.flatMap((tier) => tier.effects)])].filter((effect) => effect.kind === "set" || effect.kind === "reveal" || effect.kind === "goto" || effect.kind === "encounter" || effect.kind === "clock");
      const only = effects.length > 0 && effects.every((effect) => effect.kind === "set" && (effect.value ?? 1) > 0 && effect.flag === (effects[0] as { readonly flag?: string }).flag) ? (effects[0] as { readonly flag: string }).flag : undefined;
      read(interaction.requires, new Set(only === undefined ? [] : [only]));
    }
    for (const encounter of bible.encounters) read(encounter.schedule?.requires);
    const clears = (effects: readonly BibleEffect[] | undefined): void => {
      for (const effect of flat(effects ?? [])) if (effect.kind === "set" && (effect.value ?? 1) <= 0) this.cleared.add(effect.flag);
    };
    for (const scene of bible.scenes) clears(scene.onEnter);
    for (const interaction of bible.interactions ?? []) clears([...interaction.onSuccess, ...interaction.onFailure, ...interaction.tiers.flatMap((tier) => tier.effects)]);
    for (const encounter of bible.encounters) clears([...((encounter.onVictory ?? []) as readonly BibleEffect[]), ...((encounter.onDefeat ?? []) as readonly BibleEffect[]), ...((encounter.triggers ?? []).flatMap((trigger) => trigger.effects) as readonly BibleEffect[])]);
  }

  // An interaction a set flag has closed for good does not need its own record of having been done or tried: forgetting it merges states
  // that differ only in that record.
  private canonical(state: StoryState): StoryState {
    const shut = (id: string): boolean => {
      const interaction = (this.bible.interactions ?? []).find((candidate) => candidate.id === id);
      return interaction !== undefined && (interaction.requires.notFlags ?? []).some((flag) => flagOn(state, flag) && !this.cleared.has(flag));
    };
    const done = [...state.done].filter((id) => !shut(id));
    const tries = [...state.tries].filter(([id]) => !shut(id));
    return done.length === state.done.size && tries.length === state.tries.size ? state : { ...state, done: new Set(done), tries: new Map(tries) };
  }

  private matters(effects: readonly BibleEffect[]): boolean {
    for (const effect of flat(effects)) {
      if (effect.kind === "set" && this.flags.has(effect.flag)) return true;
      if (effect.kind === "reveal" && this.clues.has(effect.clue)) return true;
      if (effect.kind === "goto" || effect.kind === "encounter") return true;
      if (effect.kind === "clock" && this.bible.clocks.some((clock) => clock.id === effect.clock && clock.onFull !== null)) return true;
    }
    return false;
  }

  private relevant(interaction: BibleInteraction): boolean {
    return this.matters([...interaction.onSuccess, ...interaction.onFailure, ...interaction.tiers.flatMap((tier) => tier.effects)]);
  }

  // A sure step that only opens things (sets flags no requirement wants unset, reveals clues; no move, no fight) never hurts to take, so it
  // is taken at once: a table that has not taken it yet can always choose to. This keeps the order of harmless steps from multiplying states.
  private harmless(effects: readonly BibleEffect[]): boolean {
    for (const effect of flat(effects)) {
      if (effect.kind === "set" && ((effect.value ?? 1) <= 0 || this.closing.has(effect.flag))) return false;
      if (effect.kind === "goto" || effect.kind === "encounter" || effect.kind === "clock" || effect.kind === "random") return false;
    }
    return true;
  }

  public settle(state: StoryState): StoryState {
    let current = state;
    for (let changed = true; changed; ) {
      changed = false;
      const scene = this.bible.scenes.find((candidate) => candidate.id === current.scene);
      if (scene === undefined) break;
      const known = (clue: string): boolean => current.clues.has(clue) || !this.clues.has(clue);
      for (const npcId of scene.npcIds) for (const tell of this.bible.npcs.find((npc) => npc.id === npcId)?.tells ?? []) if (!known(tell.clue)) { current = { ...current, clues: new Set([...current.clues, tell.clue]) }; changed = true; }
      for (const clue of this.bible.clues) if (clue.free === true && clue.sceneId === scene.id && !known(clue.id)) { current = { ...current, clues: new Set([...current.clues, clue.id]) }; changed = true; }
      for (const interaction of this.bible.interactions ?? []) {
        if (interaction.sceneId !== scene.id || !certain(interaction) || !this.relevant(interaction) || current.done.has(interaction.id) || !met(interaction.requires, current) || !this.harmless(interaction.onSuccess)) continue;
        // Its effects only set and reveal, so taking it again changes nothing: no record is kept, and the loop stops once nothing changes.
        const [next] = this.apply(current, interaction.onSuccess, 0);
        if (next !== undefined && stateKey(next) !== stateKey(current)) { current = next; changed = true; }
      }
    }
    return this.canonical(current);
  }

  public start(): readonly { readonly label: string; readonly state: StoryState }[] {
    const empty: StoryState = { scene: this.bible.startScene, flags: new Map(), clues: new Set(), tries: new Map(), done: new Set(), clocks: new Map() };
    return this.arrive(empty, this.bible.startScene, 0).map((state) => ({ label: `start in ${this.bible.startScene}`, state }));
  }

  public isEnding(state: StoryState): boolean {
    return this.endings.has(state.scene);
  }

  public moves(state: StoryState): readonly Move[] {
    const scene = this.bible.scenes.find((candidate) => candidate.id === state.scene);
    if (scene === undefined) return [];
    // A fight the adventure scheduled breaks out by itself once it is due; waiting brings the time of day and the rounds.
    const due = this.bible.encounters.find((encounter) => encounter.schedule !== undefined && encounter.sceneId === scene.id && !state.done.has(`fight:${encounter.id}`) && met(encounter.schedule.requires, state));
    if (due !== undefined) return [{ label: `${due.id} breaks out`, outcomes: this.fight(state, due.id, 0) }];

    const moves: Move[] = [];
    // A scene that lists no exits lets the party go anywhere, as the engine plays it (the Planner sends them).
    for (const exit of scene.exits ?? this.bible.scenes.map((other) => ({ to: other.id, requires: undefined }))) {
      if (exit.to === scene.id || !met(exit.requires, state)) continue;
      moves.push({ label: `go to ${exit.to}`, outcomes: this.arrive(state, exit.to, 0).map((next) => ({ label: `arrive in ${exit.to}`, state: next })) });
    }
    // Asking whoever is here, and the clue the engine hands a stuck table: free, no roll.
    for (const npcId of scene.npcIds) {
      for (const tell of this.bible.npcs.find((npc) => npc.id === npcId)?.tells ?? []) {
        if (this.clues.has(tell.clue) && !state.clues.has(tell.clue)) moves.push({ label: `ask ${npcId} (${tell.clue})`, outcomes: [{ label: "told", state: { ...state, clues: new Set([...state.clues, tell.clue]) } }] });
      }
    }
    for (const clue of this.bible.clues) {
      if (this.clues.has(clue.id) && clue.free === true && clue.sceneId === scene.id && !state.clues.has(clue.id)) moves.push({ label: `the engine gives ${clue.id}`, outcomes: [{ label: "given", state: { ...state, clues: new Set([...state.clues, clue.id]) } }] });
    }
    for (const interaction of this.bible.interactions ?? []) {
      if (interaction.sceneId !== scene.id || !this.relevant(interaction) || (certain(interaction) && this.harmless(interaction.onSuccess)) || state.done.has(interaction.id) || (state.tries.get(interaction.id) ?? 0) >= interaction.attempts || !met(interaction.requires, state)) continue;
      moves.push({ label: interaction.id, outcomes: this.attempt(state, interaction) });
    }
    return moves;
  }

  private attempt(state: StoryState, interaction: BibleInteraction): Move["outcomes"] {
    // Success closes the interaction; only a failure that itself changes something keeps a count of tries (each one lands again).
    const succeeded: StoryState = { ...state, done: new Set([...state.done, interaction.id]) };
    const count = (state.tries.get(interaction.id) ?? 0) + 1;
    const tried: StoryState = count >= interaction.attempts ? succeeded : { ...state, tries: new Map([...state.tries, [interaction.id, count]]) };
    const outcomes: { label: string; state: StoryState }[] = [];
    // A higher total adds each tier it reaches, lowest first.
    const tiers = [...interaction.tiers].sort((a, b) => a.dc - b.dc);
    for (let reached = 0; reached <= (certain(interaction) ? 0 : tiers.length); reached += 1) {
      const effects = [...interaction.onSuccess, ...tiers.slice(0, reached).flatMap((tier) => tier.effects)];
      for (const next of this.apply(succeeded, effects, 0)) outcomes.push({ label: reached === 0 ? "success" : `success, tier ${reached}`, state: next });
    }
    if (!certain(interaction)) {
      // A roll can fail, and a fee may be more than the party has (then nothing happens, and the try is not spent). A failure that changes nothing
      // that matters is the same as failing every try, so it closes the interaction at once.
      const spent: StoryState = this.matters(interaction.onFailure) ? tried : { ...state, done: new Set([...state.done, interaction.id]) };
      if (interaction.check !== null) for (const next of this.apply(spent, interaction.onFailure, 0)) outcomes.push({ label: "failure", state: next });
      else outcomes.push({ label: "cannot pay", state });
    }
    return outcomes;
  }

  private arrive(state: StoryState, sceneId: string, depth: number): readonly StoryState[] {
    const moved: StoryState = { ...state, scene: sceneId };
    const key = `enter:${sceneId}`;
    if (state.done.has(key)) return [moved];
    const scene = this.bible.scenes.find((candidate) => candidate.id === sceneId);
    // Arriving again changes nothing unless the arrival itself matters.
    if (!this.matters(scene?.onEnter ?? [])) return [moved];
    // Setting and revealing again changes nothing, so a harmless arrival needs no record that it happened.
    if (this.harmless(scene?.onEnter ?? [])) return this.apply(moved, scene?.onEnter ?? [], depth + 1);
    return this.apply({ ...moved, done: new Set([...moved.done, key]) }, scene?.onEnter ?? [], depth + 1);
  }

  // Every state the effects can lead to: a table on the page, a fight and a filling clock each branch.
  private apply(state: StoryState, effects: readonly BibleEffect[], depth: number): readonly StoryState[] {
    let states: readonly StoryState[] = [state];
    for (const effect of effects) {
      states = states.flatMap((current) => this.one(current, effect, depth));
      if (states.length > 64) states = dedupe(states).slice(0, 64);
    }
    return dedupe(states);
  }

  private one(state: StoryState, effect: BibleEffect, depth: number): readonly StoryState[] {
    if (depth > 12) return [state];
    switch (effect.kind) {
      case "set":
        if (!this.flags.has(effect.flag)) return [state];
        return [{ ...state, flags: new Map([...state.flags, [effect.flag, effect.value ?? 1]]) }];
      case "reveal":
        if (!this.clues.has(effect.clue)) return [state];
        return [{ ...state, clues: new Set([...state.clues, effect.clue]) }];
      case "goto":
        return this.arrive(state, effect.scene, depth);
      case "encounter":
        return this.fight(state, effect.encounter, depth).map((outcome) => outcome.state);
      case "clock": {
        const clock = this.bible.clocks.find((candidate) => candidate.id === effect.clock);
        // A clock that starts no fight changes nothing the story's routes read.
        if (clock === undefined || clock.onFull === null) return [state];
        const before = state.clocks.get(clock.id) ?? 0;
        const filled = Math.min(clock.segments, before + effect.by);
        const next: StoryState = { ...state, clocks: new Map([...state.clocks, [clock.id, filled]]) };
        return filled === clock.segments && before < clock.segments && clock.onFull !== null ? this.fight(next, clock.onFull, depth).map((outcome) => outcome.state) : [next];
      }
      case "random":
        return effect.options.flatMap((option) => this.apply(state, option.effects as readonly BibleEffect[], depth + 1));
      default:
        return [state];
    }
  }

  // A fight is won or lost; each has its own consequences. A fight already fought is not fought again.
  private fight(state: StoryState, encounterId: string, depth: number): Move["outcomes"] {
    const key = `fight:${encounterId}`;
    if (state.done.has(key)) return [{ label: "already fought", state }];
    const encounter: BibleEncounter | undefined = this.bible.encounters.find((candidate) => candidate.id === encounterId);
    const fought: StoryState = { ...state, done: new Set([...state.done, key]) };
    if (encounter === undefined) return [{ label: "fought", state: fought }];
    const triggered = (encounter.triggers ?? []).flatMap((trigger) => trigger.effects.filter((effect) => effect.kind !== "add" && effect.kind !== "end" && effect.kind !== "announce")) as readonly BibleEffect[];
    return [
      ...this.apply(fought, [...triggered, ...((encounter.onVictory ?? []) as readonly BibleEffect[])], depth + 1).map((next) => ({ label: `${encounterId} won`, state: next })),
      ...this.apply(fought, (encounter.onDefeat ?? []) as readonly BibleEffect[], depth + 1).map((next) => ({ label: `${encounterId} lost`, state: next })),
    ];
  }
}

function dedupe(states: readonly StoryState[]): StoryState[] {
  const seen = new Map<string, StoryState>();
  for (const state of states) seen.set(stateKey(state), state);
  return [...seen.values()];
}

// Every state the story can reach, and those from which the table cannot force an ending.
export function searchStoryStates(bible: AdventureBible, endings: readonly string[], limit = maxStates, milliseconds = maxSearchMilliseconds): StateSearch {
  const deadline = Date.now() + milliseconds;
  const story = new Story(bible, new Set(endings));
  const states = new Map<string, StoryState>();
  const moves = new Map<string, readonly { readonly label: string; readonly targets: readonly string[] }[]>();
  const parent = new Map<string, { readonly from: string | null; readonly step: string }>();
  const queue: string[] = [];
  for (const { label, state: raw } of story.start()) {
    const state = story.settle(raw);
    const key = stateKey(state);
    if (states.has(key)) continue;
    states.set(key, state);
    parent.set(key, { from: null, step: label });
    queue.push(key);
  }
  for (let head = 0; head < queue.length; head += 1) {
    if (states.size > limit || (head % 256 === 0 && Date.now() > deadline)) return { kind: "tooLarge", states: states.size };
    const key = queue[head] as string;
    const state = states.get(key) as StoryState;
    // An ending is where the story finishes: nothing after it matters.
    if (story.isEnding(state)) { moves.set(key, []); continue; }
    const choices = story.moves(state).map((move) => ({
      label: move.label,
      targets: move.outcomes.map((outcome) => {
        const settled = story.settle(outcome.state);
        const target = stateKey(settled);
        if (!states.has(target)) {
          states.set(target, settled);
          parent.set(target, { from: key, step: `${move.label}: ${outcome.label}` });
          queue.push(target);
        }
        return target;
      }),
    }));
    moves.set(key, choices);
  }

  // Safe states, from the endings back: a state is safe when some choice leads only to safe states, whatever chance answers.
  const safe = new Set<string>([...states].filter(([, state]) => story.isEnding(state)).map(([key]) => key));
  for (let changed = true; changed; ) {
    changed = false;
    for (const key of states.keys()) {
      if (safe.has(key)) continue;
      if ((moves.get(key) ?? []).some((move) => move.targets.length > 0 && move.targets.every((target) => safe.has(target)))) {
        safe.add(key);
        changed = true;
      }
    }
  }

  const pathTo = (key: string): string[] => {
    const steps: string[] = [];
    for (let at: string | null = key; at !== null; ) {
      const link = parent.get(at);
      if (link === undefined) break;
      steps.unshift(link.step);
      at = link.from;
    }
    return steps;
  };
  // Where trouble begins: an unsafe state entered from a safe one (or the start), in visiting order, so each path is the shortest way in.
  const stranded = queue.filter((key) => !safe.has(key) && (parent.get(key)?.from == null || safe.has(parent.get(key)?.from ?? ""))).map((key) => ({ state: states.get(key) as StoryState, path: pathTo(key) }));
  return { kind: "complete", states: states.size, stranded };
}
