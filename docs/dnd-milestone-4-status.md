# Milestone 4 status: creation, house rules, and art

The plan is [§12](dnd-dm-bot-plan.md#12-delivery-milestones-and-exit-criteria). Everything here is tested with fakes for Discord and the model; none of it has met a real server yet.

## Built

- **Table-rule cards.** Seven options the engine implements (natural 20/1 on checks, away heroes, potion cost, who plays a fight, gold from fights, critical hits, item trading) plus one for saved characters' gear. Two are new and change real mechanics: *critical hits* (double dice, or the first die at its maximum) and *item trading* (with consent, or off; the pack menu loses Give). The lobby card has a **Table rules** button: the organizer picks a bundle (Standard, or BG3-style potions) or one option and its value; anyone else reads the same list; More… shows it during play. Values are checked against what the engine implements and pinned at Start.
- **Guided builder.** Class (fighter, rogue, cleric), starting kit, standard-array scores dealt ability by ability (or the suggested spread), skills and expertise, a name, and optional appearance and past. Every number is derived by the engine from those choices; an illegal build is refused with the reasons.
- **Character library (`/dnd characters`).** Kept per Discord user across servers as a chain of immutable snapshots. View, export (a file of choices and gear, never a derived number), delete on confirm, and `/dnd import-character` (re-derives everything; unknown gear, other rulesets and illegal builds are refused with named conflicts). Someone else's characters read as missing, however an ID got around.
- **Saved characters in a game.** The hero picker lists them after the adventure's heroes and previews what carries over, naming every conflict, before seating. A campaign gets its own copy (own ID, full HP); Start checks it again. Two campaigns never share live state. **Save progress** (My Hero) writes the gear from a settled game as a new snapshot on that game's own branch; two games make two branches and nothing merges. A table can choose whether earned gear comes along or the class's starting kit.
- **Adventure upload (`/dnd upload-adventure`).** Parsed by the strict schema, held to the ruleset's monsters, items and spells and to size limits, and every fight is rehearsed headlessly with the adventure's heroes through the real engine. A passing file is kept as a draft; a spoiler-free review (no DM notes, overview or secrets) offers Approve and Discard to the uploader or a DnD Admin. Approved adventures load at startup, get an ID unique to the server, and a game pins its version. Create game has an **Adventure** button when the server has more than one.
- **Adventure Author (`/dnd author`).** Turns an idea and/or notes (text or Markdown attachment) into the saved format using only the ruleset's catalog, in either language, with one repair try that carries the checker's own problems. It never writes heroes (it borrows the shipped ones); notes are fenced off as material, not orders. The result goes through the same checks and the same review.
- **Scene pictures.** The opening and each newly entered scene request a wide illustration of the narrated location. Scene and dramatic-moment prompts include the present party’s names, races, and classes; saved portraits are supplied as visual references when the configured GPT image model supports them. A natural 20 or 1 can request a moment image, with a short spacing rule to keep the channel readable, and the organizer can illustrate or redo the latest moment. There is no per-campaign image cap. Pictures run in the background; failures never block text play. A generated image is kept under `<RUNTIME_DATA_DIRECTORY>/campaign-images` until Discord receives it, so a failed post can retry without generating again. Monster portraits are generated once per kind or named NPC, with a bundled gallery fallback if the model fails. Set `CAMPAIGN_IMAGE_MODEL` to enable pictures.

## Not built

- Point buy and 4d6 ability generation, more classes, levels above 1 (the engine has no leveling).
- Book-length PDF import, OCR, chapter-by-chapter conversion, and translating a second language edition (an uploaded or authored adventure has the one edition it was written in, so games of it are in that language).
- Player-uploaded art, gallery pictures for monsters beyond the four bundled, and fallbacks for scenes and heroes.
- Changing a running game's house rules (the plan requires a preview and a migration).
- Shove, elevation and other BG3 options (the plan defers them until the engine has the data).
- Removing an approved adventure.

## Playtest checklist

- [ ] `/dnd characters`, build a rogue, then a fighter; export one and import it on another account.
- [ ] Join a lobby with a saved character; the preview names nothing wrong; play; Save progress; join a second game with the new version.
- [ ] Two games with the same character: change gear in one, the other is untouched.
- [ ] Upload the starter adventure's YAML with a new id: review, approve, create a game from it with the Adventure button.
- [ ] `/dnd author` with an idea (needs a model); read the review; approve; play a round.
- [ ] Table rules: switch critical hits and item trading, start, and see the effect.
- [ ] Set `CAMPAIGN_IMAGE_MODEL`, transition scenes, and see one picture per scene; verify that the second scene also receives a picture.
- [ ] Repeat in Traditional Chinese.
