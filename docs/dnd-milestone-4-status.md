# Milestone 4 status: creation, house rules, and art

The plan is [§12](dnd-dm-bot-plan.md#12-delivery-milestones-and-exit-criteria). Everything here is tested with fakes for Discord and the model; none of it has met a real server yet.

## Built

- **Table-rule cards.** Seven options the engine implements (natural 20/1 on checks, away heroes, potion cost, who plays a fight, gold from fights, critical hits, item trading) plus one for saved characters' gear. Two are new and change real mechanics: *critical hits* (double dice, or the first die at its maximum) and *item trading* (with consent, or off; the pack menu loses Give). The lobby card has a **Table rules** button: the organizer picks a bundle (Standard, or BG3-style potions) or one option and its value; anyone else reads the same list; More… shows it during play. Values are checked against what the engine implements and pinned at Start.
- **Guided builder.** Class (fighter, rogue, cleric), starting kit, standard-array scores dealt ability by ability (or the suggested spread), skills and expertise, a name, and optional appearance and past. Every number is derived by the engine from those choices; an illegal build is refused with the reasons.
- **Character library (`/dnd characters`).** Kept per Discord user across servers as a chain of immutable snapshots. View, export (a file of choices and gear, never a derived number), delete on confirm, and `/dnd import-character` (re-derives everything; unknown gear, other rulesets and illegal builds are refused with named conflicts). Someone else's characters read as missing, however an ID got around.
- **Saved characters in a game.** The hero picker lists them after the adventure's heroes and previews what carries over, naming every conflict, before seating. A campaign gets its own copy (own ID, full HP); Start checks it again. Two campaigns never share live state. **Save progress** (My Hero) writes the gear from a settled game as a new snapshot on that game's own branch; two games make two branches and nothing merges. A table can choose whether earned gear comes along or the class's starting kit.
- **Adventure upload (`/dnd upload-adventure`).** Parsed by the strict schema, held to the ruleset's monsters, items and spells and to size limits, and every fight is rehearsed headlessly with the adventure's heroes through the real engine. A passing file is kept as a draft; a spoiler-free review (no DM notes, overview or secrets) offers Approve and Discard to the uploader or a DnD Admin. Approved adventures load at startup, get an ID unique to the server, and a game pins its version. Create game has an **Adventure** button when the server has more than one.
- **Adventure Author (`/dnd author`).** Turns an idea and/or notes (text or Markdown attachment) into the saved format using only the ruleset's catalog, in either language, with one repair try that carries the checker's own problems. It never writes heroes (it borrows the shipped ones); notes are fenced off as material, not orders. The result goes through the same checks and the same review.
- **Scene pictures.** When the party enters a new scene, a background job paints one picture from the scene's public description alone, posts it under the scene's title, and counts it against a per-campaign budget (`CAMPAIGN_IMAGE_BUDGET`, default 12) once made. A failure, an empty budget, an oversized picture or a finished game only means no picture; text play never waits. Pictures run beside the game (one campaign at a time, a few campaigns at once), and a made picture is kept as a file under `<RUNTIME_DATA_DIRECTORY>/campaign-images` until it is posted, so a failed post is retried from the saved picture without a second bill. Monsters get a portrait the first time a fight with them breaks out (one per kind of monster, or per named NPC; saved and reused for the whole campaign), and the organizer can press **Picture this moment** in Manage to paint the last told round. Every prompt is built only from text the table has already seen (a scene's public description, a monster's name and its NPC's public description, the told narration), all pictures share the one budget, and nothing is drawn from a player's raw words. Heroes get a portrait when the party is introduced; a natural 20 or 1 in a round asks for a moment picture of its own (not right after another, and never the last three of the budget); Manage has **Redo the last picture**, which repaints it and spends budget again. A monster that cannot be painted (no budget left, or the model failed) gets a ready-made portrait from `assets/campaign/monster-gallery` (goblin, wolf, bugbear, giant wolf spider, MIT, see its NOTICE), which costs nothing and is never fetched at run time. Set `CAMPAIGN_IMAGE_MODEL` (OpenAI-compatible, uses `OPENAI_API_KEY`) to turn it on. The same setting turns on character portraits in My Characters (architecture doc, step 33); turning an uploaded picture into a portrait uses the provider’s image edit endpoint, so it needs a GPT image model, while painting from a description works with any image model.

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
- [ ] Set `CAMPAIGN_IMAGE_MODEL`, transition scenes, and see one picture per scene; set the budget to 1 and see the second scene go without.
- [ ] Repeat in Traditional Chinese.
