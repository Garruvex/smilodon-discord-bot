# Writing an adventure as data

An adventure is one YAML file per language (`en`, `zh-TW`). The Planner (the model) proposes, the engine decides: everything below is
read by the engine, so an adventure needs no code. `npm run campaign:harness` and the validator check a file, rehearse its fights and
report every problem at once.

## The graph

A **scene** is a place. It lists its NPCs, the **exits** to other scenes (an exit may require a flag), and what happens when the party
arrives (`onEnter`).

An **interaction** is something the players can attempt in a scene. The Planner sees the list of what is available now and, when a hero's
action matches one, names it by id. The engine then rolls the authored check and applies the authored results, once, however many
heroes tried it.

```yaml
interactions:
  - id: interaction:drink-from-the-trough
    sceneId: scene:field
    label: Drink from the trough        # the players' words; never shown to the Narrator
    dmNotes: The water is foul.         # tells the Planner when this applies; never shown to the Narrator
    check: { ability: con, dc: 12, save: true }   # or { skill: nature, dc: 10 }; omit for something that just happens
    requires: { flags: [gate-open], notFlags: [drunk], clues: [clue:well] }
    pay: 0                              # gold the hero pays
    attempts: 1                         # tries allowed (default one; failure is not freely retryable)
    fallback: true                      # the engine may take this step for a stalled table (no roll, no fee) after about nine rounds with no progress
    onSuccess: [{ kind: set, flag: refreshed }]
    onFailure:
      - { kind: hurt, count: 2, sides: 6, damageType: poison }   # dice decide; each rolling hero is hurt by their own failure
    tiers:                              # extra results for a higher total
      - { dc: 18, effects: [{ kind: notice, text: It tastes of honey. }] }
```

Anything the players try that is not listed is still planned by the model as before; interactions never limit play.

A scene may be marked `ending: true`: the story can finish there. Mark every final scene, including a floor ending a table that fails everything
can still reach. `npm run adventure:check -- <file>` checks the story contract (see `docs/dnd-adventure-conversion-guide.md`), and
`docs/adventure-template.yaml` is a complete adventure to start from.

An NPC may list what they will tell:

```yaml
npcs:
  - id: npc:hag
    secret: ...
    tells:
      - { clue: clue:grievance, topics: [curse, contract, 詛咒, 契約] }   # asking about any of these reveals the clue, no roll
      - { clue: clue:the-way }                                           # no topics: any question to this NPC gives it
```

Asking is a free, no-roll route to the clue; the engine decides what is told and the narrator only voices it. The story contract counts it.

## Effects

| kind | does |
| --- | --- |
| `reveal` | the party learns a clue |
| `set` | sets a flag (interactions, exits and `requires` read flags) |
| `reward` | gold and items, once (a repeat never pays twice) |
| `keepsake` | a story object with a name and description, once |
| `notice` | a line the table sees, once |
| `goto` | moves the party; the new scene's `onEnter` effects come with it |
| `encounter` | starts an authored fight (not inside a fight or an arrival) |
| `clock` | advances a skill-challenge clock |
| `time`, `weather` | pass time (`advance`: 1 to 12 phases of the day) or change the sky; only when the adventure has a `startTime` |
| `hurt` | harm between fights; `who: rollers` (default) or `party` |
| `random` | picks one of several `options` by chance when the round is planned (`weight` defaults to 1) |

`onEnter` (arriving) and `onLongRest` (the party takes a long rest in the scene) may use `reveal`, `set`, `reward`, `notice` and `keepsake`; each lands once.

## The story's clock

An adventure may give a start time; without one it keeps no clock and nobody invents one.

```yaml
startTime: { day: 1, time: dusk, weather: rain }   # time: dawn, morning, midday, afternoon, dusk, night. weather: clear, rain, storm, fog, snow, wind
```

Time moves only when the story says so, never with the wall clock or how long the table waited: `{ kind: time, advance: 2 }` passes two
phases of the day (six make a day), `{ kind: weather, weather: fog }` turns the sky, a short rest passes one phase and a long rest runs
to the next dawn. Fights do not pass time. The Narrator and the Planner are told the clock as fact, the game's cards show it, and pictures are
painted in its light. An organizer can correct it with `/dnd time` (the correction and its reason are kept in the game's history).

## Fights

```yaml
encounters:
  - id: encounter:field-midnight
    zones: [...]
    monsters:
      - { monsterId: monster:awakened-shrub, zoneId: centre, npcId: npc:scarecrow }   # an NPC gives a reskinned monster its name
      - { monsterId: monster:goblin, zoneId: centre, stats: { hp: 20, armorClass: 15, toHit: 2, damage: 1 } }   # tougher or weaker than the SRD block
    schedule: { requires: { clues: [clue:strikes-at-midnight] }, time: night, afterRounds: 2 }   # breaks out by itself (all parts optional; time needs a startTime)
    ambush: { dc: 13 }                  # foes lie in wait: the party is surprised unless a hero's passive Perception reaches this
    surprised: foes                     # or say outright who is surprised
    dread: { ability: wis, dc: 11 }     # every hero saves; one who fails is frightened until their first turn ends
    triggers:
      - when: { kind: foesDown, count: 2 }     # or { kind: round, round: 4 }; each fires once
        effects:
          - { kind: announce, text: A hag steps from the mist. }
          - { kind: add, monsters: [...] }     # foes arrive
          - { kind: end }                      # a truce: the fight ends as a win
    onVictory: [{ kind: set, flag: settled }, { kind: goto, scene: scene:hut }]
```

## What the engine keeps for itself

Flags named `tried:<interaction>`, `done:<interaction>`, `reward:<id>` and `notice:<id>` belong to the engine; authored flag names are
`a-z`, `0-9` and `-` only. Translations may change every word (labels, notes, notices, keepsake names) but not the structure: the
two editions are compared with the words removed.

## Not modelled

a monster's other stats (speed, abilities, extra attacks: only `hp`, `armorClass`, `toHit` and `damage` can change), and a hazard
for one hero that is not the one who chose the interaction (`who: party` hurts everyone, `who: rollers` those who rolled).
