# Milestone 6 status: release verification

The plan is [§12](dnd-dm-bot-plan.md#12-delivery-milestones-and-exit-criteria). This milestone's exit criterion has three parts: the acceptance scenarios pass, the pilot's play-affecting issues are resolved, and the fun rubric meets the agreed bar. **Only the first is something code can settle, and it is settled here except where the table below says otherwise. The pilot and the rubric need people at a real table; nothing has been run against a real Discord server or a real model yet.**

## PostgreSQL

Campaign data now runs on PostgreSQL when it is the configured persistence (`PERSISTENCE_DRIVER=postgres`), and on SQLite otherwise, through the same store contract.

- **Tables.** `drizzle/0019_campaign_store.sql`, eleven `campaign_*` tables in the instance's own schema. Payloads are `json`, not `jsonb`: `jsonb` reorders an object's keys, which reordered a hero party (the order heroes were written in). A parity test that plays a six-round game on both stores found this, and it now asserts the same events and final state on PostgreSQL and in memory.
- **One store contract, three stores.** The in-memory, SQLite and PostgreSQL stores run one behavior suite (compare-and-set revisions, per-campaign event numbering, idempotent commands, the outbox with its retry times, timers, saved rolls, the character library, adventures, and rollback of a failed transaction). PostgreSQL adds: a saved roll and a timer survive a restart on a new connection, a repeated command answers with its first outcome, another connection sees nothing of a failed transaction, and two racing writers on separate connections let exactly one through.
- **Turning it on for an instance that already has games.** Stop the bot, then:

  ```bash
  npm run instance:db:migrate
  npm run db:import-campaigns
  ```

  The import copies `<RUNTIME_DATA_DIRECTORY>/campaign.sqlite` into the PostgreSQL tables in one transaction, in their original order, and reads back identically (tested). It only reads the SQLite file, and a second run copies nothing. Start the bot; Discord messages already on the server keep working because their IDs came across in the records.
- **Running the PostgreSQL tests.** Set `CAMPAIGN_TEST_DATABASE_URL` to a database you do not mind them using (each test file makes its own schema from the campaign migration alone). Without it they are skipped, so a plain `npm test` needs no server. They passed against PostgreSQL 16 on the development machine.

## Acceptance scenarios (plan §13)

"Covered" means an automated test exercises it with fakes for Discord and the model. "Real table" means it needs people.

| # | Scenario | State |
| --- | --- | --- |
| 1, 2, 3 | Lobby seat race, repeated Join, only the organizer starts | Covered (lobby service and controls) |
| 4 | Rules change invalidates readiness; unsupported options cannot be chosen | Covered for what exists: rules are checked against the engine's options and pinned at Start, and the builder refuses unsupported choices. No option yet changes a hero's legality |
| 5 | Others cannot read private notes or spend a hero's resources | Covered (ownership checks on every private control) |
| 6 | Stale popup gets a useful private conflict | Covered (engine refusals become private text) |
| 7 | Repeated Roll/action and retries never reroll or double-spend | Covered (idempotent commands, saved rolls; on all three stores) |
| 8, 39 | Reaction windows; Shield waits for the reaction | **Not built.** No starter spell or feature needs a reaction; heroes' opportunity attacks are automatic |
| 9 | Crash after a saved roll resumes from the same result | Covered (SQLite file, PostgreSQL) |
| 10 | Delivery failure keeps state and leaves recoverable work | Covered (milestone 3: backoff, nonces, Repair) |
| 11 | Deleted cards come back, including after being offline | Covered |
| 12 | Missing permissions or channels become an organizer issue; archived stays archived | Covered (milestone 3) |
| 13 | Simultaneous actions serialize; a stale revision is refused | Covered (bus, all stores) |
| 14 | Rounds close when everyone answers, on the timer, or by the organizer; deadlines survive restart and pause | Covered |
| 15 | Missed timers apply the away policy; coming back rejoins with a recap | Covered (recap added in milestone 5) |
| 16 | Autopilot never spends resources, speaks, or makes story choices | Covered (cautious autopilot) |
| 17 | A proxy acts only within the owner's grant and only while they are away | Covered for **fights** (a named player takes the away hero's turns; nothing else is reachable). Exploration rounds have no proxy |
| 18 | Player text claiming items, stats or authority changes nothing | Covered (Planner validation; injection persona in the harness) |
| 19 | Language and names stay consistent over a multi-session run | Covered in scripted form; **real model needs the table** |
| 20 | Numbers in narration match state; summaries never hold HP or resources | Covered (the engine refuses such a summary) |
| 21 | Secrets never reach public cards, journals, recaps, or image prompts | Covered (context, Chronicler, journal, recap and image-prompt tests) |
| 22 | Image failure or budget leaves text play working; late images attach correctly | Covered |
| 23 | Separate campaigns and reusable characters never share live state | Covered (library and two-campaign tests) |
| 24 | Pausing and resuming a fight keeps eligibility and timer durations | Covered |
| 25 | A bad Planner proposal is retried once, then held | Covered |
| 26 | Regenerate narration never rerolls or changes state | Covered (Manage: Retell the last scene) |
| 27 | Safety is anonymous and steers the next narration | Covered |
| 28 | Off-ladder DCs and unknown IDs are refused | Covered |
| 29 | Monster turns need no model call | Covered |
| 30 | `zh-TW` output has no Simplified-only characters | Covered for the harness corpus; **real model output needs reading** |
| 31 | A complete pilot in each language | **Real table** |
| 32 | Narrator and summary payloads exclude secrets | Covered |
| 33 | Unlock-then-enter dependencies | Not applicable: the catalog has no such dependency |
| 34 | Timeouts reach a defined state; an all-away party makes no empty rounds | Covered |
| 35 | A delayed Chronicler cannot overwrite newer facts | Covered |
| 36 | A long scene and a large ledger stay within budget | Covered |
| 37 | Restart tests preserve a database across processes | Covered on SQLite (a killed child process) and PostgreSQL (new connections) |
| 38 | Panel layouts pass the panel spec's scenarios on mobile | **Real table** (layouts are tested for structure, not appearance) |
| 40 | Opportunity attacks | Covered |
| 41 | Target menu agrees with the positioning contract | Covered |
| 42 | DCs come from formulas or content | Covered |
| 43 | A protected away hero cannot die | Covered |
| 44 | Bless concentration | Covered |

## What is left

- **The pilot and the rubric.** Play a session in each language with a real model, following the checklists in the milestone [1](dnd-milestone-1-status.md), [2](dnd-milestone-2-status.md), [3](dnd-milestone-3-status.md), [4](dnd-milestone-4-status.md) and [5](dnd-milestone-5-status.md) statuses, and rate the transcripts with the [milestone 0 rubric](dnd-milestone-0-report.md). Milestone 0's sign-off still needs two human ratings per transcript and a dollar cost.
- **Reactions** (scenarios 8 and 39), **exploration proxy play**, and the **rules-depth track** (leveling, terrain, shops, more conditions and monsters) stay open, with owners in the plan.
- **Nothing has been deployed.** The branch is unpushed. To try it: push, then on the server `git pull`, `docker compose build bot-pinecone`, `docker compose up -d --no-deps bot-pinecone`; run `npm run deploy:commands` for the new `/dnd` subcommands (`characters`, `import-character`, `upload-adventure`, `author`, `reopen`); to move to PostgreSQL follow the steps above first.
