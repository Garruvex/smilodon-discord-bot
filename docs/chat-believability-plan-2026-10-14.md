# Believability plan: a character people can actually talk to

Date: 2026-10-14. Implementation update: 2026-10-15. Status: local implementation complete; live human acceptance pending. Builds on [the review](chat-naturalness-review-2026-10-14.md) and the [current design](chat-naturalness-design.md).

Implemented on `codex/chat-believability-memory-isolation`, based on latest fetched `main` (`862942bb`). The earlier deployment blockers were already merged. This branch implements the registry, all thirteen modules, translated settings, decision-provider fallback, burst/context/continuation fixes, evaluation commands and an offline replay runner. New character modules, expanded context, summaries and scheduled probes default off; addressing, thoughts and boundary decisions default to shadow mode when enabled. Existing participation has stricter context prerequisites and corrected cooldown handling.

Module ownership is enforced in both backends before candidate caps, ranking, aliases, prompt sources, conflict/corroboration queries and graph expansion. Derived impressions validate source revisions, original provenance IDs and current visibility before recall. Optional turns revalidate module context before delivery; direct/name-triggered replies keep their original snapshot while settings/persona/exclusions and explicit-forgetting privacy guards remain live. Callback claims use persistent guild quotas and conditional transitions; uncertain delivery is suppressed rather than blindly repeated. Confirmed Discord messages are the only source for canon learned from delivered output. Owner-authored personality and lore take precedence over generated canon.

The automated checks establish engineering behavior, not whether people find the character believable. No live module activation, deployment, week-long pilot, consented real-conversation replay or human preference result has been claimed. PostgreSQL lifecycle cases are included in the shared contract; live execution requires a test database. See the [operator and pilot guide](chat-believability-operations.md) for setup and acceptance work.

Final local verification after review fixes: 4,287 tests passed across 316 files; five environment-dependent suites were skipped. Type checking, the production build, lint for every changed TypeScript file, migration checks and whitespace checks passed. Repository-wide lint remains failing in unrelated existing activity/generated files and campaign tests. Regression coverage includes module isolation before candidate caps, SQLite upgrades, derived-source forgetting/correction, callback concurrency/recovery, burst preservation, continuation budgets, context-off cancellation, restart retention, probe consent boundaries, mood expiry, safe message sizing, confirmed-delivery canon learning, stable solicited replies, revision-scoped callback planning/backoff, combined personal/canon extraction, cross-slot polarity conflicts, probe-batch cooldown/budgets and composed module dependencies.

## Goal

The bot should feel like a specific person who is part of the server: consistent in who it is, aware of who it is talking to, selective about when it speaks, and shaped like a human in how it writes. Success is judged by the people who talk to it, not by benchmark scores, judge-model ratings, or message volume.

The research papers are a source of mechanisms, not targets. Each idea below is adapted to the Discord setting and kept only if it makes conversations feel more human in practice.

**Non-goals:** reproducing paper architectures or scores; maximizing helpfulness; maximizing activity; pretending to be human when someone sincerely asks.

## 1. What "believable" means here

Observable qualities, each of which a server member could notice when it breaks:

| Quality | Breaks when the bot… |
| --- | --- |
| Stable identity | Contradicts its own tastes, history, or opinions between conversations. |
| Knows people | Treats a regular like a stranger, or mixes up who said what. |
| Human memory | Recites lists of facts, remembers trivia perfectly, or invents a shared past. |
| Social timing | Replies to everything, instantly, or interrupts a conversation it isn't part of. |
| Human message shape | Writes paragraphs, bullet lists, or "Great question!" in casual chat. |
| Inner life | Never brings anything up itself, never follows up on things people mentioned. |
| Emotional continuity | Is cheerful right after being insulted, or stays in a mood forever. |
| Honest limits | Claims to have done something it can't, or hides a failure behind a joke. |

## 2. What already exists to build on

| Existing piece | Role in this plan |
| --- | --- |
| Persona core + lore bundle, example exchanges, `personality.md` sections such as *No Assistant Reflex* | Identity source of truth. Currently enforced only by prompt. |
| Persona drift (slow, ≤300 chars, on consolidation) | Long-term mood/quirk. Kept; a fast mood layer is added beside it. |
| Shared memory with provenance, aliases, forgetting | Basis for relationships, hedged recall, and callbacks. |
| Episodes, `ChatScheduler`, participation decisions, shadow mode | Basis for the inner-thought loop and timing. |
| Optional structured social provider (`DECISION_*`) | Standard chat-completions JSON output; cost depends on the selected model. Motivation thresholds remain experimental. |
| Utility/D&D exclusions, access policy | Hard boundaries every new path must keep. |

## 3. Adapt, don't reproduce

| Source | Take | Leave out | Why |
| --- | --- | --- | --- |
| Inner Thoughts (Liu et al., 2025) | Form candidate thoughts covertly, rate how much the character wants to say each, hold them, and speak when there is a natural opening. | Continuous monologue on every message; the full framework. | The human-like part is *holding a thought and choosing the moment*, not volume of thinking. |
| Generative Agents (Park et al., 2023) | Reflection: periodically turn observations into impressions of people and of itself. A light "what I'm up to today" sketch. Interview-style evaluation. | Simulated town, full daily planning, agent-to-agent simulation. | Impressions and a consistent day are what make a character feel present; the simulation isn't needed. |
| LongMemEval / LoCoMo | Their failure categories: stale updates, time confusion, wrong speaker, answering when it should abstain. Long-run conversation replays. | Scores and QA accuracy as goals. | Used as a checklist of ways memory feels wrong, not as a target. |

Any further paper cited later (for example on role-play consistency) must be verified before it is added to the design document.

## 4. Workstreams

Each workstream lists the change, what it reuses, its guardrail, and how it is judged done. "Judged" means by people, through the evaluation loop in section 4H.

### A. Stable identity and self-consistency

**Problem.** The character's tastes and self-descriptions are regenerated every turn, so it can like cats on Monday and dislike them on Tuesday. The current safeguard correctly blocks bot statements from becoming member facts, but nothing keeps the character consistent with itself.

**Change.** Add a *character canon* ledger, separate from member memory:
- Records only what the character says about itself: tastes, opinions, fictional history, running jokes.
- Low authority: `personality.md` and lore always win; a canon entry that contradicts them is discarded.
- Retrieved like lore, by relevance, into a small budget.
- Owner-reviewable: list, edit, delete, and a "freeze" switch that stops new entries.
- Never holds facts about members or the real world, and never confirms anything as true.

**Done when.** In replayed and live conversations, reviewers find no self-contradictions across sessions on the probes in 4H.

### B. Relationships with individual people

**Problem.** The bot recalls facts about someone but has no sense of the relationship: how well it knows them, their shared jokes, or whether teasing is welcome.

**Change.** A reflection job, run after consolidation, writes a short impression per person and visibility scope:
- Source-backed familiarity, recurring topics and shared jokes. Teasing/tone preferences are loaded fresh from user customization, never inferred or copied into the impression.
- Each note cites the episodes or memories it came from.
- Partition source inputs before generation by audience, private owner, channel, and isolation scope. Never combine isolated or private evidence into a guild-visible impression. The output audience is no broader than every supporting source allows; a mixed batch produces separate impressions or is skipped when no valid common scope exists.
- Record supporting memory revisions and episode/message IDs as dependencies. Forgetting, superseding, expiring, or narrowing access to a supporting source invalidates the impression before another recall; regeneration uses only remaining eligible evidence and honors forget cutoffs. Citing a source alone does not implement this lifecycle.
- Neutral or positive and factual only. Never store judgements such as "this person is annoying".
- Visible and forgettable by that person through `/memory`, using the same lifecycle as facts.

**Reuses.** Episodes, shared memory provenance, user customization (which already carries teasing/tone preferences).

**Done when.** Regulars and newcomers are treated noticeably differently in blind comparisons, and no impression is found that the person would object to seeing. Lifecycle checks confirm that isolated evidence never reaches another channel and that forgetting or correcting a source prevents recall of its old derived impression.

### C. Inner thoughts and timing

**Problem.** Participation is a yes/no reaction to each event. People instead think of something, wait, and say it when it fits.

**Change.** An event-driven thought loop for channels where participation is enabled:
1. A structured social call over a short window asks whether a contribution is worthwhile. This is a standard model request, not a specialized native decision API.
2. Form one to three short candidate thoughts, each tied to the message it responds to.
3. The same model call generates candidates and rates their motivation, using relevance, what the character would add, persona interests and recent speaking share. This is self-rating, not an independent scoring stage. The 0.5 reply threshold and default 0.7 thought/target thresholds are provisional heuristics; no calibration has been performed.
4. Hold thoughts in a short-lived reservoir (minutes, not hours). Thoughts are never stored as memory.
5. Speak when there is an opening: a pause in the conversation, someone addressing the bot, or the thought becoming relevant again. Drop it when the topic moves on.

**Reuses.** Episodes, `ChatScheduler` budgets, burst batching, shadow mode, the decision module.

**Guardrails.** Off by default; shadow mode first, followed by human-labeled calibration before pilot activation; all exclusions and budgets apply; a held thought never becomes a reply to a different topic.

**Done when.** In a pilot channel, people rate unprompted contributions as relevant and well-timed, and complaints about interruptions do not rise.

### D. Memory that feels human

**Problem.** Perfect recall and list-style answers feel mechanical, and the bot rarely uses what it knows unprompted.

**Changes.**
- **Hedged recall.** Wording follows age and evidence: "didn't you say you were learning guitar?" for an old or single-source fact; a direct statement for a recent, confirmed one. Ask rather than assert when evidence conflicts.
- **Say where it came from.** "Alice mentioned you were moving" instead of stating third-party claims as fact.
- **Callbacks.** For schedule and event facts with a date (exams, trips, launches), follow up once after the date: "how did the exam go?". Budgeted, only where continuation is enabled, only if the person has been active recently, and never in excluded channels.
- **Fading trivia.** Lower the retrieval weight of low-importance episodic details over time instead of deleting them. Facts the person explicitly asked the bot to remember never fade.
- **No recital.** "What do you remember about me?" gets a few natural highlights and an offer to say more, not a dump.

**Callback delivery contract.** Each callback is keyed by the event's canonical identity and revision, subject, and permitted delivery scope. A repository operation atomically claims the current due revision with a lease and attempt ID; concurrent workers cannot claim the same attempt. State transitions use conditional updates, preserve the event fact and its provenance, and never overwrite a newer revision. A corrected or cancelled event invalidates pending attempts. Changing only the date of an event already followed up does not automatically authorize another callback.

Immediately before sending, recheck the current event revision, source eligibility, forgetting, module and master switches, continuation, recent member activity, destination scope/access, exclusions, and scheduler output budget. A failed check cancels or defers the attempt without marking it delivered. Disabling callbacks invalidates pending claims; re-enabling admits only still-current, eligible events.

Record the Discord message ID and completion marker after a confirmed send. Retry known failures with bounded backoff and a maximum callback age. After a restart, reclaim an expired lease only when delivery has not begun or is known to have failed. If a timeout or crash leaves delivery uncertain, reconcile against the recorded attempt/message origin where possible; otherwise suppress automatic retry and record the uncertain outcome for review. A lease alone cannot guarantee exactly-once delivery across the database and Discord. All of this state remains in the event's callback metadata, using explicit repository operations rather than a separate follow-up table.

**Done when.** Reviewers find no invented shared past in replays, and callbacks are rated as welcome rather than creepy. Delivery checks cover concurrent claims, known send failures, restart recovery, uncertain sends, date corrections, forgetting, and disablement between claim and delivery.

### E. Voice and message shape

**Problem.** The persona file asks for short, casual, no-markdown chat, but only the prompt enforces it, so assistant habits leak through.

**Changes.**
- **Style profile.** Derived from example exchanges and approved past bot messages: reply-length distribution, emoji and punctuation habits, language mixing, typical openers.
- **Deterministic voice check after generation.** Flag markdown lists and headings in casual chat, assistant phrases ("Great question", "As an AI", "I hope this helps"), and replies far outside the length profile. Default to safe trimming without an extra model call. Explicit regenerate mode adds at most one call for severe casual length/Markdown violations; mild removable openers do not trigger regeneration. Functional outputs (tool results) are exempt.
- **Message shape.** Optionally split a reply into one to three messages the way the character would type them, with short typing delays proportional to length. Total delay is bounded (a few seconds) and never applies to functional results or direct requests that need an answer.
- **Match the room.** Short replies in fast banter, longer ones when asked something substantive.

**Done when.** Blind reviewers cannot pick the bot out by formatting alone in casual-chat samples, and substantive questions still get complete answers.

### F. Mood

**Problem.** Persona drift moves slowly; nothing reflects the last ten minutes.

**Change.** A fast mood state per channel (for example amused, tired, annoyed, pleased), nudged by recent interactions and decaying back to baseline within minutes to hours. It colors tone only. It is never stored as a fact about anyone, and serious or distressed conversations override it immediately.

**Done when.** Reviewers notice continuity within a session and no lingering grudges across sessions.

### G. Group behavior

**Conversation context without reply links (prerequisite for everything in C and G).** Most messages are typed plainly, so the reply chain is usually empty and, with channel history off by default (8 messages when on), the bot answers and decides from almost no surrounding conversation. Make recent channel context the primary context:
- A time-based window of the current conversation verbatim: roughly the last 15–20 minutes, about 30–40 messages, under a character budget. A long silence (about 10 minutes) starts a new conversation segment instead of relying on reply links.
- A short running summary of the earlier part of the same conversation, refreshed by the utility model only when the window overflows.
- Keep the decision window short. The decision step sees the current burst plus the preceding 5–10 messages (default 10, configurable), which is enough to judge addressing and whether a contribution is worthwhile. The main reply gets only the segment it needs.
- One decision request asks all independent questions over that shared window: addressing (`choice`), motivation (`score`), where the current topic starts (`choice` over candidate boundaries inside the window that local code derives from time gaps and changes in who's talking, plus "earlier than this window"), and an optional reaction emoji (`choice`). Two separate requests would pay for the window twice.
- **Reply target.** Direct mentions, replies to the bot, and name triggers keep their triggering message as the fixed target. For continuation, spontaneous, and reaction-only answers, the same decision request adds a `choice` over a short candidate list: burst messages, unanswered questions in the window, and lines local signals mark as aimed at the bot. The bot's own messages, ineligible utility or game messages, and messages it already answered are excluded. "The latest message" is always a candidate and wins ties or low confidence. Without the decision module, the target is the latest message, or the most recent line local signals mark as addressed to the bot.
- **Delivery follows the target.** When the target is the latest message, send a plain message without a reply link. When it is an earlier message, reply to that message so readers can see what is being answered, the same way people use replies to return to an older line. The reply prompt marks the target explicitly and presents the rest of the segment as context. Each candidate is checked for eligibility on its own, and the target is rechecked before delivery.
- When the answer is "earlier than this window", local code selects the reply's segment by time gaps (back to the last long silence, within the reply budget) and adds the running summary. The decision window never has to grow to find an old topic start.
- The main reply receives the chosen segment verbatim plus the running summary when earlier context is needed. A floor (the last ~8 messages and the current message) and a ceiling (the reply context budget) apply whatever the decision picks, so under-selection never leaves the reply blind.
- Fallbacks: without the decision endpoint, the same questions go to the utility model as one structured-output call over the same short window. With no decision model configured, the reply uses the fixed default window. Boundary choices are logged in shadow mode and compared with reviewer picks before they drive live replies.
- Default on for chatbot-allowed channels is a product decision: it sends bystanders' messages to the model provider, so it needs disclosure and an admin toggle, and it respects memory modes and exclusions.
- Cost: mostly larger calls, about 1,500–3,000 extra input tokens per main call, plus the attribution check, which runs whenever channel context is present (about +1 utility call per reply turn).

**Implicit addressing (prerequisite for C and for natural follow-ups).** Most Discord messages are typed plainly, without a reply link or a mention; people use replies mainly to return to an older topic. Today a plain follow-up only reaches the bot through the continuation trigger, which recognizes just the one person the bot replied to within two minutes. Add an addressing step for plain messages in channels where the bot was recently active:
- Cheap local signals first: time since the bot's last message, whether anyone else spoke in between, second-person wording ("you", "你"), the character's names and aliases, a question shortly after the bot spoke, and whether the speaker took part in the bot's recent exchange.
- When signals are ambiguous, one decision-module `choice` question: addressed to the bot / continuing the bot's topic / between other people / unclear. Unclear defaults to not addressed.
- Let other participants in the bot's recent exchange count, not only the person it replied to, so "same lol" from a third person can be part of the conversation.
- Context selection for plain messages groups by time adjacency and participants instead of reply branches, and keeps interleaved topics apart where signals allow.
- Store the inferred link with a confidence and a "reply" or "inferred" label so attribution never treats a guess as a real reply.

**Unprompted triggers: batching, context, and limits.** The continuation and spontaneous triggers already exist (`ProactiveChatBehavior`, `ChatScheduler`), but four problems make them behave unlike a person in plain-typed conversation:

1. **Evaluate the whole burst, not only its last message.** Burst batching (4 s quiet, 10 s maximum wait) currently keeps only the last message's job, and earlier burst messages reach the model only through channel history, which is off by default. A burst such as "did anyone finish the event?" / "not yet" / "the boss is so hard lol" is judged as the last line alone. The buffer collects every eligible message in the burst; the turn receives them as the current exchange, with the last message as the trigger, not as background history. Cost stays at one evaluation per burst.
2. **Continuation and spontaneous require conversation context.** Both triggers depend on the conversation they join. They become runtime `dependsOn` conversation context, and settings explain the dependency instead of letting them run blind. Direct and name-triggered replies keep working without it. When the decision module is configured, the gate sees the burst plus its short decision window and the reply sees the burst plus the chosen segment, as described above.
3. **Continuation gets its own budget.** It is currently admitted and limited like an unprompted interjection: one optional evaluation per channel per 25 s, and at least 90 s between unprompted texts. An ordinary plain-typed back-and-forth therefore stalls at about one bot reply per 90 s, and follow-ups inside the evaluation cooldown are dropped. Continuation is an active exchange, so it uses an exchange budget instead: no per-message text cooldown inside an active exchange, a cap of bot replies per exchange (default about 8–10) and per channel per 10 minutes, the exchange ending after about 2 minutes without a bot-relevant message, and burst batching still preventing one call per fragment. Spontaneous participation keeps the strict evaluation and text cooldowns. Both still count toward the per-guild optional-turn cap and concurrency limit.
4. **Only name-triggered turns set the name-trigger cooldown.** `AmbientChatBehavior.execute` sets `ambientCooldownSeconds` for every trigger, so a spontaneous evaluation that decides to stay silent can make the bot ignore someone who says its name seconds later. Continuation and spontaneous turns use only their own scheduler limits.

**Other changes.**
- Address people by the names the server uses for them (observed aliases), and the right person in multi-person threads.
- Don't dominate: speaking share counts against the motivation score in C.
- When several people talk at once, answer the thread the character cares about, or acknowledge more than one briefly.

### H. Evaluation loop (human-first)

- **Blind pairwise comparisons.** Sample real conversation moments, generate the current and candidate responses, and ask server regulars which feels more like the character and more like a person. Track preference as a diagnostic, not a target.
- **Interview probes.** Adapted from Generative Agents' interview evaluation: scripted questions about the character itself, its memory of members, what it is up to, how it reacts to situations, and what it thinks of things. Re-run after every change to catch contradictions.
- **"Felt like a bot" flag.** A moderator message command that tags a bot message with a category (wrong person, assistant tone, bad timing, contradiction, too much, too little). Flags become regression cases.
- **Long-run replays.** Weeks of real, consented, anonymized conversation replayed against the bot to check consistency drift and memory failures by the LongMemEval/LoCoMo categories.
- **Never:** optimize for a judge model's score, or for message count.

## 5. Modules, settings, and storage

Every workstream ships as an independent module that is off by default, toggleable per guild and per channel, and removable without affecting the others. Character behavior is optional; the context prerequisite, burst preservation, truthful identity guard and corrected trigger budgets are correctness fixes in the shared chat pipeline.

### Module contract

Each module has its own implementation file and settings schema. A composition file selects modules without editing the runtime. A `CharacterModule` registry handles context, output, decision, extraction and consolidation hooks. A runtime coordinates decision windows, targets, summaries and scheduled work:

| Member | Purpose |
| --- | --- |
| `id`, `settingsPath` | Stable identifier and its settings node. |
| `dependsOn` | Other modules, or capabilities such as the decision module or continuation, that must be enabled. Unmet dependencies disable the module and are explained in settings. |
| `isEnabled(profile, channelId)` | Resolves the guild setting, channel override, master switch, memory mode, and exclusions. Rechecked before delivery. |
| `memoryPolicy` | Declares ownership of module-created records and their eligibility for conversational reads. The memory layer enforces this policy before candidate limits, ranking, and serialization. |
| `contributeContext(turn)` | Adds bounded prompt sections, each with its own character budget. |
| `postProcess(reply)` | Optional output pass (voice check, message splitting). Never applied to functional tool output. |
| `onObservation(event)` / `onConsolidation(batch)` | Optional hooks for learning from episodes. |
| Runtime jobs | Reflection follows consolidation; callback/probe timers are tracked and drained at shutdown. Public callbacks and synthetic probes use existing scheduler admission and guild concurrency. |

Disabling a module stops its hooks, its prompt sections, and its jobs immediately, cancels pending output, and excludes its stored records from conversational reads. Its stored data stays until the guild clears it explicitly, subject to retention and expiry. Authorized management listing and deletion remain available while the module is off. Re-enabling uses only still-valid data whose sources and visibility remain eligible.

The same read policy applies to ordinary recall, `lookup_memory`, related-memory expansion, summaries, and module context contributions. Cached or queued context carries its contributing module IDs and is invalidated or rebuilt when enablement changes. Recheck configuration/persona/access before output so an in-flight turn cannot deliver module content after disablement. Solicited turns retain their start-of-turn memory snapshot; ordinary learning and mood expiry do not suppress them. Explicit forgetting still cancels affected turns through conversation privacy versions. Optional contributions retain strict context validation. Canon and impressions cannot enter generic fact recall outside their owning module's contribution; mood and daily sketches are module context only. Ordinary event facts remain recallable when callbacks are off, but callback metadata never becomes prompt content.

### Settings

All modules are registered in the existing settings registry, so slash commands and the admin panel read and write the same values with the same validation, translations, and access checks. A new `character` group (`/settings-character`) holds the modules. Retention for memory-backed modules is configured under the existing `/settings-memory`, next to `sharing` and `memory-mode`.

| Module | Settings node | Guild controls | Channel override | Requires |
| --- | --- | --- | --- | --- |
| Master switch | `character.enabled` | on/off; turns every module below off when off | yes | chatbot enabled |
| Character canon (A) | `character.modules.canon` | on/off, freeze (stop new entries), budget, list/edit/delete action | no (guild-wide identity) | master |
| Relationships (B) | `character.modules.relationships` | on/off, refresh interval, budget | yes | master, memory sharing |
| Inner thoughts (C) | `character.modules.thoughts` | on/off, shadow, motivation threshold, hold time | yes | master, conversation context, implicit addressing, continuation or spontaneous participation, decision module |
| Hedged recall (D) | `character.modules.recall-style` | on/off | yes | master |
| Callbacks (D) | `character.modules.callbacks` | on/off, max per day, minimum delay after the event | yes | master, continuation participation, memory sharing |
| Fading trivia (D) | `character.modules.fading` | on/off, half-life | no | master |
| Voice check (E) | `character.modules.voice` | on/off, strictness (default trim / opt-in regeneration for severe violations) | yes | master |
| Message shape (E) | `character.modules.message-shape` | on/off, max messages, max total delay | yes | master |
| Fast mood (F) | `character.modules.mood` | on/off, decay time | yes | master |
| Conversation context (G) | `character.context` alongside existing `memory.channel-history`; window minutes, segment gap, summary, budget, shadow and decision window (5–20 messages, default 10) | enabled, window, budget, decision window | yes | chatbot enabled; respects memory modes |
| Unprompted trigger limits (G) | `participation.controls`, `participation.activity-limits` and `participation.continuation-limits`; exchange cap 10, channel cap 30/10 min, fixed 2 min idle timeout | existing toggles plus the new limits | yes (existing `participation-channel` override) | chatbot enabled; continuation and spontaneous also require conversation context |
| Implicit addressing (G) | `character.modules.addressing` | on/off, shadow, include other participants; fixed 2 min follow-up window | yes | master, conversation context, continuation participation; decision module optional (local signals only without it) |
| Group behavior (G) | `character.modules.group` | on/off | yes | master, conversation context |
| Daily sketch (5) | `character.modules.daily-sketch` | on/off | no | master, canon |
| Evaluation tools (H) | `character.modules.evaluation` | "felt like a bot" flag on/off, probe schedule (daily default, minimum hourly) | no | none (can run with modules off to record a baseline) |

Rules shared by all rows:
- Defaults are off, so a schema upgrade never changes behavior.
- Precedence: exclusions and access, then the master switch, then the module's guild setting, then the channel override. A channel override can only narrow enabled guild modules/context; it cannot enable a disabled guild module or bypass exclusions.
- The panel and `/settings-character status [channel]` expose dependency status. D&D ownership, utility-origin, thread access and current member permission are checked by live Discord eligibility immediately before output.
- Instance-level capabilities such as `DECISION_*` stay in environment configuration. Guild settings can only use what the instance provides.
- Conversation context is a capability checked in the current channel, including memory modes and exclusions. Turning it off disables dependent addressing, thoughts, and group behavior immediately, including their shadow evaluations and pending output; an old cached window does not satisfy the dependency.

### Storage through the memory interface

Anything a module remembers goes through `MemoryEngine`/`MemoryRepository`. Reuse the existing audience, channel-mode, provenance, listing, forgetting, and cutoff mechanisms, and extend them explicitly for module ownership, derived-source dependencies, and callback transitions in both database backends. Sharing a store does not automatically supply these guarantees. Module-created records carry a stable `moduleId`; callback state belongs to metadata on an ordinary event fact rather than taking ownership of that fact.

| Module data | Memory representation | Who can see and delete it |
| --- | --- | --- |
| Character canon | New subject type `persona` (the character itself), kinds `fact`/`preference`, audience `guild`. Written only through a dedicated canon ingest path. That path is the single exception to the bot-asserter rule, and it can never write `member` subjects. | Guild owner/admins, through the canon setting action. |
| Relationship impressions | New kind `impression`, subject `member`, partitioned by visibility scope. Audience cannot exceed supporting sources; dependency metadata identifies their revisions and episode/message IDs. Recalled through the enabled relationships module only when that person is in the conversation. | The person, through `/memory`, like any fact about them, with existing scope checks. |
| Callbacks | Existing schedule/event facts, with versioned callback metadata in `structuredValue`: due/expiry time, status, lease, attempt ID, retry state, and delivered message ID. Explicit repository operations query, claim, cancel, and complete due revisions atomically. No separate follow-up table. | The person, through `/memory`. Forgetting or superseding the fact invalidates pending attempts. |
| Fading trivia | No new data: a decay term in recall scoring, driven by `importance` and age, configured through the enabled fading module's half-life. | Not applicable. |
| Fast mood | Subject `persona`, kind `state`, audience `channel`, short `expiresAt`, no embedding. | Admins; expires on its own. |
| Daily sketch | Subject `persona`, kind `episode`, audience `guild`, expires at the end of the day. | Admins; expires on its own. |

Deliberately **not** stored as memory:
- **Thoughts (C)** are short-lived and live only in the scheduler's in-process reservoir. A thought is not a fact and must never be recalled as one.
- **Style profile (E)** is derived from the persona and its examples, so it is derived from the full example corpus per turn and is never stored as a memory.
- **Evaluation flags (H)** are review data, kept in their own evaluation store like the memory-relevance traces.

New memory kinds and the `persona` subject type need the same lifecycle tests as shared facts: recall eligibility, isolation, listing, forgetting, cutoffs, and SQLite/PostgreSQL parity. Add module-disable checks for every conversational read path and cached/in-flight context, while confirming that authorized management remains available. Derived-record checks must exercise mixed scopes, source correction/deletion, and failed regeneration; callback checks must exercise conditional transitions and recovery. These are delivery prerequisites alongside the human evaluation.

## 6. Guardrails

- **Honest about being a bot.** In character for casual banter, but a sincere "are you a bot / a real person?" gets a truthful answer.
- **Real-person personas.** If the character is modeled on a real person, that person's consent is required, and their real messages are used for style only with consent.
- **No fabricated shared past.** The character's fictional life lives in lore and canon; it never invents events involving real members.
- **No real-world claims.** It never claims to have taken a real action it can't take (bookings, payments, meeting up).
- **Safety overrides persona.** Distress, self-harm, or serious topics drop mood, teasing, and banter.
- **People own what's about them.** Relationship notes and facts are listable and forgettable; canon about the character is owner-controlled.
- **Existing boundaries hold.** Utility and D&D exclusions, access policy, memory modes, and budgets apply to every new path.

## 7. Phases

| Phase | Work | Prerequisites | Judged done when |
| --- | --- | --- | --- |
| 0 | Fix the four deployment blockers from the implementation review (memory activation switch, configurable limits, channel-history gating of episodes, freshness suppression). Fix the unprompted triggers (G): whole-burst evaluation, conversation-context dependency for continuation and spontaneous, a separate continuation exchange budget, and name-trigger cooldown only for name-triggered turns. Split the current work into reviewable PRs. Add the decision module with a fallback to the current participation call. Add the "felt like a bot" flag and interview probes so later phases have a baseline. | — | Existing behavior is unchanged with new settings off; baseline transcripts and flags are collected. Fake-clock tests show a plain-typed continuation exchange is not stalled by the spontaneous cooldowns, a multi-message burst reaches the model as one exchange, continuation and spontaneous stay off without conversation context, and a silent spontaneous evaluation does not block a later name-triggered reply. |
| 1 | Voice and message shape (E). | 0 | Formatting tells disappear in blind samples; direct answers stay complete. |
| 2 | Character canon and fast mood (A, F). | 0 | No self-contradictions on interview probes across a week. |
| 3 | Relationships, hedged recall, callbacks, fading trivia (B, D). | 0, memory lifecycle fixes | Regulars feel recognized; no invented past; callbacks rated welcome; derived-scope and callback delivery lifecycle checks pass. |
| 3a | Conversation context window and running summary (G). | 0 | Replies to plain-typed follow-ups show awareness of the surrounding conversation in blind samples; token cost per call measured. |
| 3b | Implicit addressing (G), in shadow mode first: log what it would have treated as addressed and compare with human labels. | 0, 3a | Plain-typed follow-ups are recognized without pings; conversations between other people are not mistaken for ones with the bot; chosen reply targets match reviewer picks in shadow logs, and earlier targets are delivered as Discord replies; disabling context stops addressing evaluations. |
| 4 | Inner thoughts and timing, group behavior (C, G). Shadow mode, then one pilot channel. | 0, 3a, 3b, decision module calibrated on shadow data | Unprompted contributions rated relevant and well-timed in the pilot; dependency changes cancel pending contributions. |
| 5 | Optional "what I'm up to today" sketch from lore, consistent within a day. | 2 | Reviewers find it adds presence without contradicting lore. |

Phase 0 also adds the `CharacterModule` registry, the `character` settings group with its master switch, the `persona` subject type, and module ownership/read-policy enforcement across memory paths. Each later phase adds its modules with their settings (off by default), translations, memory lifecycle tests where they store data, and the regression cases their evaluation produced. Phase 0 must demonstrate that disabled module records cannot affect replies or tool recall, while authorized listing and forgetting still work. Phase dependencies above also become runtime `dependsOn` checks; implementation order alone does not enforce them.

### Review fixes (2026-10-15)

- Direct/name-triggered turns accept ordinary module-memory changes instead of re-rendering all context before every tool/delivery check. Settings, persona, exclusion and explicit-forgetting checks remain active; optional turns keep strict validation.
- Callback date planning queries the current subject in SQL, reserves a revision with a conditional metadata update, caches unresolved dates until revision changes, and backs off malformed/failed normalization for 30 minutes. Reflection queries are also subject-scoped. Planning metadata stays out of ordinary recall prompts.
- Shadow context/addressing/thought settings do not add a decision call to mentions. A direct turn makes one only when context boundaries are explicitly live. Solicited turns do not generate candidate thoughts.
- Voice defaults to trim; regeneration is opt-in for severe formatting/length violations. Canon shares the existing personal-memory extraction request, with separate output evidence rules. Global semantic consistency is requested across slots and a local polarity guard rejects common opposite statements across slots or within one batch. Arbitrary semantic contradictions still require human review.
- Modules and their schemas are separate. Relationships and mood keep their own 30-minute defaults; scheduled interviews default to one per day. Probe batches share one evaluation admission/cooldown and reserve budget for every answer (seven for an interview, two for a pair).
- A callback replies to its original eligible event message when available in the delivery channel. Otherwise it sends a standalone follow-up instead of replying to unrelated current activity. Serious-topic detection intentionally remains a broad conservative local heuristic, with possible false positives.
- The structured social request combines candidate generation and self-rating. It is only economical with an appropriately small model, is not a specialized decision endpoint and has no independently calibrated scoring stage. Shadow labels and human acceptance remain rollout prerequisites.

### Implementation and acceptance status (2026-10-15)

| Phases | Engineering delivery | Human acceptance still required |
| --- | --- | --- |
| 0 | Existing blockers merged; isolation migrations, registry/settings, short decision window, burst preservation, context dependencies, continuation budgets, name cooldown, flags/probes implemented. | Collect disclosed baseline transcripts and review flags. |
| 1 | Example-derived voice repair, direct/substantive/tool exemptions, bounded split delivery and source re-verification implemented. | Blind casual-chat comparisons; confirm complete direct answers. |
| 2 | Source-hashed canon, admin ledger/freeze, confirmed-delivery learning and expiring channel mood implemented. | Cross-session interview probes over a week. |
| 3 | Scope-partitioned reflections, fresh tone preferences, hedged recall, persistent callback lifecycle and optional episodic decay implemented. | Member review of impressions and whether callbacks are welcome. |
| 3a–3b | Bounded extended episodes, restart retention, summary, sanitized earlier reply targets, inferred-link metadata and shadow decision logs implemented. | Label addressing/boundaries/targets and measure model cost. |
| 4 | Expiring topic/source-bound candidate speech, motivation/speaking-share gate and group guidance implemented. | Calibrate shadow decisions, then evaluate interruptions in one pilot channel. |
| 5 | Lore/canon-only fictional day sketch with guild-local midnight expiry implemented. | Explicitly choose fictional daily life and review lore consistency. |

Canon is learned only in shared durable-memory channels, avoiding promotion of isolated/session-only dialogue into a guild-wide identity. Thoughts are short candidate speech, not persisted internal reasoning. Mood uses bounded local signals; fictional sketches and reflections use the utility provider. Interviews and blind pairs are synthetic, private review outputs; real transcript comparisons still require an approved anonymized replay corpus. Unknown Discord outcomes remain uncertain until an operator reviews them. Production rollout is a separate action after acceptance.

## 8. Pilot decisions

1. Is the character fictional, or modeled on a real person? This sets the consent requirements in section 6.
2. How should it answer a sincere "are you a bot?" Recommended: truthfully, in its own voice.
3. May the character have a fictional daily life (phase 5)?
4. Should people see the bot's impressions of them in `/memory`? Recommended: yes.
5. Are split messages and short typing delays wanted, or should replies stay single messages?
6. Should recent channel context be on by default in chatbot-allowed channels? It makes replies far better for plain-typed conversation, but sends bystanders' messages to the model provider.
