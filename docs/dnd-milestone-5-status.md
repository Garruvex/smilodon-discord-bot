# Milestone 5 status: multi-session continuity

The plan is [§12](dnd-dm-bot-plan.md#12-delivery-milestones-and-exit-criteria). Tested with a scripted DM and Chronicler; the real model's summaries have not been read by a person yet.

## Built

- **The Chronicler.** A background call, after a scene closes or six narrated rounds pile up, that condenses the rounds since the last summary **twice**: a *public* summary written from the public transcript alone (what the Narrator may read), and a *DM-only* one written from everything the Planner knows. Each also proposes up to five small ledger facts about named people, places and items, keyed by entity ID. It runs after the table already has its text, and a failed run is retried; without a model nothing is summarized and play is unaffected.
- **What the engine enforces.** A summary is kept as an event on the saved game. A late one (its rounds already covered by a newer summary), one for rounds not yet told, or one that states hit points, spell slots or gold is refused: those numbers come from live state only. A ledger fact that tries to rename a known person is dropped, so the first spelling stays.
- **Compaction.** Rounds a summary covers leave the transcript, except the latest two, which stay word for word. Layer D ("Story so far") carries the summaries, oldest first; under a tight budget the oldest summaries give way before anything else, and the latest round is never dropped. The Narrator only ever receives public summaries; the Planner also gets the DM-only ones, marked.
- **Entity-keyed retrieval.** A ledger of up to 25 entities is shown whole. A larger one shows only the entities present in the scene or named in the last rounds or in the actions being resolved, with the last five facts of each, and says how many it left out. The Narrator never receives a secret fact.
- **Journal and recap.** More… has **Journal** (the public chapters with the rounds they cover, what the world remembers by name, clues found) and **Recap** (where the party is, the latest chapter, the last things told). **I'm back** now ends with the recap. Both read public data only.
- **Three sessions, scripted.** One test plays three sessions of five rounds with a pause and a day's wait between, and checks the exit criterion: summaries at rounds 6 and 12 for both audiences, a public transcript that never held a Planner-only reason or secret line, one canonical name for one person however often they are mentioned, and no Narrator request that contains anything private.
- **Play-by-post.** The Play-by-post preset (a day per round, twelve hours per roll or turn) gets the halfway reminders from milestone 3; nothing else differs. The pilot itself is a real-table run.

## Not built

- Chapter-level summaries of summaries (older summaries are dropped, not merged, when the budget is very tight).
- An automatic public Journal post in a channel; Journal is a private view.
- A Chronicler for the second language of a bilingual game (each game has one language).
- Embedding search; retrieval is by entity and name.

## Playtest checklist

- [ ] Play at least seven rounds with a model configured; read the public and DM-only summaries the Chronicler wrote (they are in the event log as `summaryRecorded`).
- [ ] Journal after a scene change: the chapter, the people, the clues; nothing secret.
- [ ] Go away and come back after a few rounds: the recap is right.
- [ ] Ask the Narrator about a person from an early round after many rounds: the name and facts hold.
- [ ] Repeat in Traditional Chinese, and read the summaries for Simplified characters.
