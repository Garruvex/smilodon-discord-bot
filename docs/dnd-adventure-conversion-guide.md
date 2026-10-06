# Converting a story into an adventure

This guide is for whoever turns a story (a module, a one-shot, an outline) into the adventure format: a person, or any language model. Give a
model this file, `docs/adventure-template.yaml`, the format reference (`docs/dnd-adventure-authoring.md`), and the source story. Then run the
checker until it is clean:

```
npm run adventure:check -- path/to/adventure.yaml
```

The checker prints every problem with what to do about it. Exit code 1 means there are errors. **Do not stop until it prints OK and you have
read the warnings.**

## The one rule

> From every state the story can reach, the table has a way forward to an ending, even if every roll fails and nobody guesses a clever idea.

A mystery cannot ask players to guess the exact words that move it on. The engine plays what you wrote: it rolls the checks you list, applies
the results you list, and goes where your exits and `goto` effects say. Anything you do not write down cannot happen. So write down the way
forward, and write down the way forward *when things go badly*.

## What the checker enforces

| Rule | It means | How to fix it |
| --- | --- | --- |
| `unreachable-scene` | No exit, `goto` or arrival leads to the scene, even when everything succeeds. | Add the exit or `goto`, or delete the scene. |
| `dead-end-scene` | A scene lists `exits: []` and is not an ending, so the party is stuck. | Give it an exit, or mark it `ending: true`. |
| `unsatisfiable-requirement` | An exit or interaction needs a flag or clue that nothing ever sets or reveals. | Set the flag or reveal the clue somewhere, or drop the requirement. |
| `ending-stranded` | An ending can be reached only if some roll succeeds (or some paid step is paid). With every roll failing, the story stops. | Give each gate a way that needs no roll, or an `onFailure` that still moves on. |
| `rolled-gate` (warning) | One roll, one attempt, no failure branch decides something the story needs. | Add attempts, an `onFailure`, or another interaction that gives the same result. |
| `no-ending` (warning) | No scene is marked `ending: true`, so finishing cannot be checked. | Mark the final scene(s). |

## How to convert, step by step

1. **List the beats.** Write the story as a short chain: how it starts, the discoveries, the confrontations, how it can end. Note every
   different ending the source allows (a peaceful one, a violent one, a failure).
2. **Make scenes** for each place. Give every scene `exits` (the places the party can go next) except an ending. Mark each final scene
   `ending: true`. Use `requires` on an exit only when the story really gates it.
3. **Make interactions** for each thing the players can do that matters: talk, search, persuade, climb, fight, pay, rest. Write the `label`
   in the players' words, because the Activity shows it to them as a suggestion.
4. **Give every gate a free key.** For each flag, clue or exit the story needs next, make sure at least one way to get it needs *no roll*: an
   interaction without a `check`, an arrival effect (`onEnter`), or a fight result. If you keep a rolled way (it feels better to roll), keep the free
   way too, or give the rolled interaction more `attempts`, or an `onFailure` that moves on at a cost.
5. **Plant the clues.** A player must be able to learn what to do next. Every important next step needs a clue that is revealed without a roll
   (arrival effect or an automatic interaction). Put a better version behind a roll if you like.
6. **Schedule time-based events.** If something happens "at midnight" or "when the alarm sounds", do not rely on a player saying "I wait". Say it
   in a clue the table learns for free, and (once the engine supports it) start it from the scene's arrival or a clock, never from a request.
7. **Make failure a branch, not a wall.** A lost negotiation can lead to the fight. A failed search can cost time. A failed lock can be broken,
   noisily. The story continues; it just gets harder.
8. **Add a floor ending.** If the party fails everything, there is still a scene that closes the story (the village suffers, the culprit escapes,
   the festival goes on without them). Mark it `ending: true`.
9. **Run the checker and fix what it says.** Then read the warnings.

## Do not invent

The narrator and the NPCs are language models and will happily invent. Give them nothing to invent from, and do not invite it.

- **Items:** an item exists only if you list it in an `reward` or `keepsake`, or the heroes' sheets. Do not describe a worn or carried object (a
  coin, a ring, a sword) in an NPC's `publicDescription` unless you mean it as description only; the engine treats what a person wears or carries
  as theirs, not as loot.
- **Terms and prices:** an NPC's demands and offers come from your `dmNotes`, `secret` and interactions. If the source gives a price, write it down; if
  it does not, do not make one up.
- **Hints reveal, they do not create.** A clue's `publicText` states a fact that is already true in the story.
- **Never put a secret in a public field.** `publicDescription`, `details`, `publicText` and `label` may reach the players.

## Writing the fields

- `label`: what the players are doing, in their words ("Ask the innkeeper about the old well"). This is a suggestion button, not a command.
- `dmNotes`: when it applies. Planner-only.
- `check`: omit it for something that simply happens. Prefer omitting it for every step the story cannot go on without.
- `attempts`: how many tries (1 to 10). Raise it for anything the story needs.
- `onFailure`: use it. Even `[{ kind: notice, text: "..." }]` helps; `{ kind: set, flag: ... }` or `{ kind: goto, ... }` makes it a branch.
- `ending: true` on a scene: the story can finish here.

## Checklist before you hand it over

- [ ] `npm run adventure:check` prints OK and no `ending-stranded`.
- [ ] Every important next step has a clue that needs no roll.
- [ ] Every "at midnight / when the bell rings" event is something the table is told about for free.
- [ ] There is at least one ending a failing table can still reach.
- [ ] No item, price or demand appears that the source story does not state.
- [ ] Nothing secret is in a public field.
