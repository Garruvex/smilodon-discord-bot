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
    onSuccess: [{ kind: set, flag: refreshed }]
    onFailure:
      - { kind: hurt, count: 2, sides: 6, damageType: poison }   # dice decide; each rolling hero is hurt by their own failure
    tiers:                              # extra results for a higher total
      - { dc: 18, effects: [{ kind: notice, text: It tastes of honey. }] }
```

Anything the players try that is not listed is still planned by the model as before; interactions never limit play.

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
| `hurt` | harm between fights; `who: rollers` (default) or `party` |
| `random` | picks one of several `options` by chance when the round is planned (`weight` defaults to 1) |

`onEnter` (arriving) and `onLongRest` (the party takes a long rest in the scene) may use `reveal`, `set`, `reward`, `notice` and `keepsake`; each lands once.

## Fights

```yaml
encounters:
  - id: encounter:field-midnight
    zones: [...]
    monsters:
      - { monsterId: monster:awakened-shrub, zoneId: centre, npcId: npc:scarecrow }   # an NPC gives a reskinned monster its name
      - { monsterId: monster:goblin, zoneId: centre, stats: { hp: 20, armorClass: 15, toHit: 2, damage: 1 } }   # tougher or weaker than the SRD block
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
