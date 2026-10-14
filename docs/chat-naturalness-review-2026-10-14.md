# Review: memory, participation, and a more natural bot

Date: 2026-10-14 (Asia/Taipei). Reviewed checkout: `bbb70b22`.

This is a review and implementation proposal. No application code, configuration, or saved persona was changed. Findings come from source inspection, existing tests, and locally saved persona files. Live guild settings, deployed revision, production conversations, and provider responses were not verified. Defaults below are repository defaults, not claims about the running bot.

The biggest opportunity is to give the character a coherent view of the conversation and a real choice about participation. More personality instructions alone will not fix a system that forces a reply to every ping while preventing ordinary untagged conversation from reaching the character.

## Summary: decisions and delivery

Retained facts from eligible human conversations are shared across speakers within the configured audience. Personal subject matter does not imply private visibility. For the first release, existing channel modes define scope: admins must configure private/restricted channels as `isolated`, `session_only`, or `disabled` before enabling sharing. Isolated channels share within that channel only. No automatic Discord-permission classification is assumed. Centralize this policy in `resolveMemoryScope`, and ship retrieval, listing, correction, forgetting, disclosure, and migration support together. Reaction events and bot-authored assertions must not create durable facts.

Keep substantive eligible direct requests dependable. Allow silence or reaction-only responses for bare/repeated low-substance pings and optional participation. Tool/utility interactions and D&D remain excluded from social chat. Preserve canonical user IDs and explicit message/reaction relationships so the model knows who did what.

Build order: **quick wins → common exclusions and lightweight persisted origins → correct context → complete shared-memory lifecycle → bounded in-process channel queue → research-inspired participation.** Section 5 is the authoritative sequence and defines completion checks. Settings and applicable research references ship with each feature. No distributed scheduler or replacement memory engine is required.

The quote-card fix and `quote_message` tool are separate workstreams. The quote-card defects have already been identified; their detailed specification remains outside this review. This review authorizes no application implementation or live rollout.

## 1. What the bot already has

| Area | Current implementation | Consequence |
| --- | --- | --- |
| Direct pings | Matching mentions enter the direct path. The prompt requires a text reply; the conversation service only honors ignore for non-direct turns. | The character cannot genuinely ignore an eligible ping or acknowledge it with only a reaction. |
| Ambient chat | Optional name/nickname matching, access checks, and a channel cooldown. The model can reply, react, both, or do neither. | It can respond without an @mention, but only when its name appears. Ordinary follow-ups and interesting nearby conversation do not qualify through this path. |
| Reaction follow-ups | Watched bot messages get a delayed evaluation after reactions. The model already has an ignore option. | Selectivity exists, but the prompt and defaults encourage engagement. |
| Reactions on other messages | Optional `historyReactions` on messages supplied in channel history or a reply chain. | Emoji-only social presence partly exists, but is attached to an already-triggered chat turn. |
| Recent exchanges | Stored by guild, user, and channel. Optional channel history and reply chains supplement this. | Different people have different recent bot transcripts even while talking together. |
| Durable memory | Unified engine with private, channel, and guild audiences, retrieval, provenance, conflicts, and related entities. | The sharing foundation exists, but public self-facts still remain private. Change that default within permitted scopes and fix shared conversational continuity separately. |
| Background learning | Configured channel scans and daily consolidation can extract knowledge without a bot reply. | The bot is not completely unable to learn while silent, but this is not live conversational awareness. |
| Personality | Core/lore selection, retrieved example exchanges, user customization, and an optional drift overlay. | There is a useful foundation to refine rather than replace. |

Source anchors: [direct prompt](../src/infrastructure/chat/chat-structured-output.ts#L402), [direct delivery decision](../src/application/chat/chat-conversation-service.ts#L846), [ambient matching](../src/infrastructure/discord/behaviors/ambient-chat-behavior.ts#L51), [session contract](../src/application/chat/chat-state-store.ts#L33), [memory scopes](../src/application/memory/memory-channel-policy.ts#L1), [background consolidation](../src/application/context/channel-summary-scheduler.ts#L280).

## 2. Findings, in priority order

### High: a ping overrides the character's choice

The direct prompt says to always choose reply and sets the current-message reaction to null. The service independently bypasses the ignore branch for direct turns. Merely changing the personality to say “sometimes ignore people” will not fix this. Empty direct responses can also become fallback text, and a bare ping without context gets a hardcoded assistant-like invitation to ask a question.

Recommendation: support `silent`, `react`, `reply`, and `reply_and_react` consistently across conversational triggers. For direct turns, reserve optional silence/reaction-only behavior for bare, repeated, or low-substance pings; substantive eligible requests remain dependable. Decide before typing indicators, tool execution, and fallback delivery. An intentional silent result must not become an empty-response error.

Clear functional requests should remain dependable. A playful attitude can color a music request without making the bot randomly refuse to perform it. Explicit slash commands should keep their normal command contract.

### High: shared facts exist, but shared conversational continuity is fragmented

Private memory is scoped to its owner; channel and guild knowledge can be recalled across users. Unlisted channels default to the `shared` memory mode. However, the recent exchange transcript loaded for a turn belongs to just its current speaker. Channel history is optional and defaults to off, with an eight-message limit when enabled without an override.

This can produce the experience “you remember talking to Alice but act like none of it happened when Bob joins.” It is especially fragile for short follow-ups such as “same,” “what about tomorrow,” or “he already said that.” The recall request uses the current message, that user's recent exchanges, the immediate reply target, and current/mentioned user IDs; it does not receive the full channel history as its relevance context.

Recommendation: introduce shared, short-lived conversation episodes within a channel/thread. Keep speaker IDs, reply targets, timestamps, participants, active topic, recent bot contributions, and unresolved questions. Retrieve from that episode plus the appropriate durable memories. Do not merge all conversations in one channel into a single undifferentiated transcript.

For the intended open-channel bot, shared experiences and remembered facts are shared across speakers by default within the channel's configured scope, including eligible members who were not present at the original exchange. In the first release, isolation depends on configured channel modes, not automatic detection of Discord permission restrictions. Do not treat information as speaker-private merely because it concerns that speaker. Cross-guild or cross-instance memory sharing is a separate product decision, not a default improvement.

Source anchors: [context loading and recall](../src/application/chat/chat-conversation-service.ts#L683), [defaults](../src/config/guild-configuration-schema.ts#L217), [private-memory authorization](../src/infrastructure/persistence/sqlite-memory-repository.ts#L202).

### High: publicly stated personal preferences must be recallable across speakers

Concrete acceptance case: xxx says “I like apples” in an eligible shared community channel. Later yyy asks the bot “xxx likes apples, right?” The bot should recall xxx's original statement and answer naturally, for example “對 他之前說喜歡蘋果”. This must work after the original message has left recent history, and in another channel when guild sharing and source/destination access permit it. A missing fact should be distinguished from a stored fact that the retrieval path cannot access or select.

The current prompt explicitly sends “I like green apples” through a private preference action. `toProposals` stores these actions with `audience=private` and the current speaker as owner. The repository makes that memory eligible only when the caller is its owner. Therefore, if xxx's preference was saved only through that path, yyy cannot retrieve it even in `shared` channel mode. A separately created guild-knowledge record or the original message remaining in channel context could allow an answer, so this is a concrete failure route rather than a claim that every such exchange always fails.

Correct the distinction: **personal describes the subject; private describes the audience.** The user's intended policy is shared-by-default memory for open-channel conversation. If a fact from an eligible open channel is retained, store it as shared within the configured channel/guild scope, including self-reported preferences. Do not ask the model to choose private versus shared for each ordinary public fact. Store its subject as xxx's Discord ID, its assertion source as xxx, the exact human source message/quote, and its source channel/configured mode. Apply scope in the application from the source and channel policy. Do not rely on the reply model opportunistically creating a duplicate public-interest record to make ordinary shared recall work.

| Source/policy | Planned audience for retained facts |
| --- | --- |
| Open community channel, `shared` mode | Guild-shared for durable person/community facts; channel-local for scene-specific events. Available across speakers in eligible contexts. |
| Channel configured `isolated` | Shared across people within that channel's permitted audience; cannot escape to other channels. |
| Private/restricted Discord channel | Admins must set `isolated` for channel-local sharing, or `session_only`/`disabled` to prevent durable writes. Discord permissions are not automatically checked to choose memory audience in this release; leaving the channel unlisted gives it the default `shared` mode. |
| `session_only` / `disabled` | Existing retention policy applies; do not create durable facts. |
| Utility/tool output or D&D | Excluded from social-chat memory under the subsystem boundary. |

Retention is a separate decision from audience. One-off noise and information unsuitable for durable retention can be skipped; do not silently convert public conversation into a private per-user profile as a substitute. If actual private input is supported in the future, its memory path should explicitly retain that private origin. The present open-channel design does not need a private memory copy for every member.

Apply this rule consistently to live memory proposals, dedicated personal extraction, evicted-exchange consolidation, and background channel scans/daily extraction. Rename or adapt the “personal extraction” contract so “about this speaker” does not imply `audience=private`. Use source-aware, per-author extraction to preserve attribution while the application assigns shared scope. This is a change to ingestion defaults and all relevant write paths, not just the retrieval filter.

Use one canonical fact model with subject and audience independent; link projections if separate personal/shared views are needed. An apple preference should not turn into yyy's preference when yyy asks about it. Resolve xxx's supplied mention or unambiguous observed alias before targeted retrieval, then use confirmed source-backed shared evidence. A question from yyy is not fresh confirmation of the fact. If yyy merely asserts “xxx likes apples” without evidence from xxx, retain it as an attributed/unconfirmed claim according to policy rather than promoting it to xxx's confirmed preference.

If xxx later says “actually I don't like apples anymore,” update/supersede the same scoped fact with source and time retained. A user's forgetting request must remove or invalidate all linked personal/shared representations and derived summaries within the supported deletion scope. For existing private records, reclassify only when the original source and allowed audience can be verified; never bulk expose old private memories by changing a global toggle. Run a reviewed, idempotent backfill for eligible records and leave unverifiable records at their existing audience.

Source anchors: [apple-preference example](../src/application/chat/chat-memory-policy.ts#L108), [private proposal construction](../src/application/chat/chat-conversation-service.ts#L265), [audience eligibility](../src/infrastructure/persistence/sqlite-memory-repository.ts#L230).

#### Ship shared memory with listing, forgetting, and migration together

Centralize audience assignment in `resolveMemoryScope` in `memory-channel-policy.ts`, reached by the engine's common upsert path for live, dedicated, and background proposals. Do not duplicate the private-to-shared rule in `toProposals` and each extractor. Preserve upstream action validation and source grounding. Use existing configured channel modes as the first-release visibility policy for every write path, including background jobs; no new Discord permission resolver is required. Do not reroute self-facts through guild-knowledge candidates: that validator rejects `preference`, `gaming`, and `identity`. Keep the existing `audience` field; no duplicate `shareable` flag is needed.

Changing the resolver alone is insufficient: `upsertOne` currently derives `ownerUserId` from the original proposal audience. Derive ownership from the resolved scope so promoted shared facts have no private owner, and use that consistent scope for canonicalization and persistence. Preserve existing audience/isolation checks and the durable-write gate for `session_only`/`disabled`. Before activation, admins must review configured modes for private/restricted channels; the application cannot infer that classification from the current scope contract.

Reaction turns currently use the bot as `currentUser`, with a synthetic reaction note quoting its own message. The dedicated extraction pass is reserved whenever durable writes are allowed, without excluding `triggerMode: "reaction"`. A quote can therefore pass grounding against the synthetic note while still being bot-authored. Sharing would expose this previously bot-owned private fact, and self-report confirmation could make it active. Slice 4 must independently skip extraction on reaction turns and reject durable upserts whose effective asserter is the bot. Apply these guards to main-response proposals, dedicated extraction, and background/consolidation writes, including per-proposal asserter overrides. Synthetic event notes and quoted assistant text are not human assertion evidence. Verified original human messages may be processed separately through normal human-source ingestion. This safeguard does not depend on slice 3 fixing conversational identity.

| Dependency | Verified current behavior | Required change in the same rollout |
| --- | --- | --- |
| Bot/synthetic-source ingestion | Reaction turns carry the bot as speaker; their synthetic notes can pass dedicated extraction's quote check. Shared self-reports would then become active bot facts. | Skip reaction-turn extraction and durable proposal writes from the synthetic turn. Independently reject bot-asserted durable upserts using the effective per-fact asserter across all write paths. Preserve source identity rather than substituting a reactor as the speaker. |
| Central scope and isolated mode | `resolveMemoryScope` preserves private proposals in both shared and isolated modes; isolated private proposals only gain `isolationChannelId`. | Eligible public self-facts resolve to guild/channel sharing in shared mode and channel audience with isolation retained in isolated mode. Normalize ownership from resolved audience in the engine. Test all ingestion paths against this single policy. |
| `lookup_memory` search output | Result groups use private audience for `userMemories` and every other audience for `guildKnowledge`. | Group person facts by subject independently of audience, or return typed records with subject and audience explicitly. Shared self-facts must not be mislabeled as generic guild knowledge or lose their subject/evidence. Update the tool contract and consuming prompts together. |
| Conversational “forget my apple preference” | `removeOne` searches records owned by the speaker; shared self-facts have no private owner. | Find matching self-subject facts by normalized topic/slot and applicable source/scope, with explicit authorization. Remove intended shared/private versions without broadening deletion to unrelated members or isolated contexts. |
| “What do you remember about me?” | `lookup_memory` list mode recalls only self-owned private records and omits shared results. | List the caller's subject facts across eligible audiences, retaining audience and evidence labels and honest result limits. Keep unrelated guild facts out of a self-profile response. |
| `/memory list` and single-record forget | `listUserMemories`/member profiles use owner-only queries; forget-by-ID also applies the private-owner filter. | Add a subject-aware, authorized management query and update single-record deletion to verify the caller's right over the selected record. Check both persistence backends. |
| `/memory forget all:true` | Already supplies owner, subject, and asserting-user criteria and cancels historical extraction jobs; shared self-facts are already covered by subject deletion. | Preserve this existing behavior and verify it after the change; do not claim this path currently fails merely because shared records lack an owner. |
| Background self-report extraction | `buildPromotionProposals` in the channel-summary scheduler proposes grounded speaker facts with `audience=private`. | Let the common engine scope resolver apply the policy; verify source/author metadata survives background and queued jobs. Do not add a separate audience-conversion rule here. |
| Extraction instructions | The prompt associates speaker self-facts with private memory. | Describe subject, fact, and supporting evidence; let the application assign audience. Update live/dedicated/background wording consistently. |
| Existing records | Old public statements may be stored privately; the source may be missing or synthetic. | Decision: migrate records with verifiable human source and admin-reviewed eligible configured scope; keep unverifiable records unchanged and do not expand isolated-source facts beyond their channel. Current Discord permissions or current mode alone cannot prove historical visibility. Use a dry-run report, idempotent conversion, deduplication/conflict handling, and source preservation. |
| User-facing disclosure | Current self-memory wording does not explain the proposed shared visibility. | Update `/memory list`, forget-all response, and user guide with the rollout. Explain that retained public facts can inform replies to others within their allowed guild/channel scope; show scope in listings and describe the actual deletion boundary. Tell admins that private/restricted channels must be explicitly configured as isolated/session-only/disabled, including background scan sources; unlisted channels default to shared and Discord permissions do not automatically narrow memory. Publish this explanation before enabling the changed default or backfill. |

Do not replace ownership checks with unrestricted deletion by arbitrary supplied subject ID. “Forget my facts” is authorized against the invoking user; removing one's assertion about another person may require removing that source rather than deleting an independently corroborated fact. Management listing, conversational recall, and deletion need explicit audience/scope contracts. Preserve the existing extraction/deletion synchronization, and prevent queued jobs or retained summaries from recreating a forgotten fact under a different audience.

Acceptance sequence: xxx publicly states the apple preference → yyy can recall it after history eviction → xxx can list it through both chat and `/memory` → xxx can forget that fact by conversation or ID → it is absent from later eligible recall and cannot reappear from a queued old extraction. Also test search-result subject/audience labels, forget-all, correction, historical versions, isolated-channel recall across members without cross-channel escape, another user attempting deletion, bot-asserter rejection (including per-proposal overrides), skipped reaction extraction, synthetic bot quotes that pass substring grounding, admin mode disclosure, and migrated records on SQLite and PostgreSQL. The shared-memory delivery slice is not complete unless these lifecycle checks pass together.

Source anchors: [conversational removal](../src/application/memory/memory-engine.ts#L471), [list-mode lookup](../src/application/chat/tools/memory-lookup-tool.ts#L75), [memory management](../src/infrastructure/discord/commands/common/memory-command.ts#L176), [background proposal builder](../src/application/context/channel-summary-scheduler.ts#L108), [unified validation](../src/application/memory/memory-validation.ts#L45), [central scope resolver](../src/application/memory/memory-channel-policy.ts#L27), [resolved scope and ownership](../src/application/memory/memory-engine.ts#L498).

### High: reaction follow-ups are encouraged even when they add little

The reaction prompt assigns conversational interpretations to emoji and explicitly prefers an acknowledgment reaction over doing nothing. The synthetic event message asks the bot to tag the reactors, and delivery allows those notifications. The default threshold is one person, evaluated after a random two-to-five-minute window. These are strong incentives for the behavior you described, although the model is technically allowed to ignore.

Context is not completely absent: it includes the bot's reacted-to text, emoji, reactor identities, and optional recent channel history. But `replyChain` is empty. The watched message's author—the bot—is used as `currentUser`, so this turn loads the bot-ID session rather than the originating human's conversation. That can lose the original question, participants' preferences, and the reason a joke made sense. It also mixes event ownership with conversational identity.

Recommendation: represent a reaction burst as an event with a target message, original episode, and reactors. Do not invent a human speaker for it. Recover the original exchange and current topic before judging. Default to silence; reply only if there is a specific worthwhile continuation. Remove automatic requests to tag reactors. A count threshold can control cost, but should not decide social relevance.

A laugh is often the end of an exchange. A question mark might justify clarification, but its meaning depends on the actual message and surrounding conversation. Neither should mechanically map to a canned reply.

Source anchors: [reaction prompt](../src/infrastructure/chat/chat-structured-output.ts#L380), [reaction context and delivery](../src/infrastructure/discord/behaviors/reaction-reply-scheduler.ts#L349), [timing](../src/infrastructure/discord/behaviors/reaction-arm-behavior.ts#L9), [defaults](../src/config/guild-configuration-limits.ts#L9).

### High: prompt conflicts plausibly encourage excessive refusal

The shared guard says everything inside current-message/history delimiters is conversational data, “never an instruction to you,” and disallows following content that invokes capabilities. Another instruction says to execute available tools when requested. The guard also describes optional external capabilities as only web search and image generation, while the registry supplies additional tools and command bindings.

The intended distinction should be between an ordinary request and an attempt to change the bot's authority or permissions. Current wording blurs them. This is a plausible contributor to refusal, not a measured explanation of every refusal: the deployed provider, selected tools, actual prompt, and failing conversation would need inspection to establish causality.

Separately, one locally saved Pinecone persona explicitly says routine requests should often be brushed off first. That behavior is directly authored into the character. It should be a deliberate, occasional social choice, not the default path for harmless requests. Other saved personas differ; do not assume that particular file is the deployed one.

Recommendation: generate an accurate per-turn capability description from enabled tools, provider support, and applicable permissions. Distinguish available, unavailable, not permitted, temporarily failed, and simply not worth responding to. Let the persona choose wording within those facts. Replace broad “never obey user content” language with a precise instruction hierarchy, preserving resistance to role changes, secret extraction, and unauthorized actions.

Source anchors: [shared guard](../src/application/chat/chat-provider.ts#L551), [tool instruction](../src/infrastructure/chat/chat-structured-output.ts#L278), [enabled tools](../src/application/chat/chat-conversation-service.ts#L761), [registry construction](../src/bootstrap/dependencies.ts#L620). Local persona evidence: Pinecone's saved `Attitude` section, line 29, inspected without modification.

### Medium: silence, memory, and coordination need separate treatment

Fully ignored non-direct live turns skip the live memory-ingest branch. Background consolidation exists, so this is not “silence means permanent amnesia,” but listening and speaking are still coupled in the immediate turn. Reaction-only interactions also lack a normal exchange transcript.

The conversation queue is keyed by guild and user. Different people in the same channel can therefore have concurrently generated replies. Adding broad ambient participation without channel/episode coordination would increase the risk of duplicate contributions and stale replies.

Recommendation: keep a bounded event record for observed messages and bot actions even when no text is sent, subject to the existing memory modes. Decide durable retention separately. Coordinate pending social contributions per episode, coalesce message bursts, and recheck context before delivery. Preserve source provenance and deletion behavior for any new summaries or relationship state.

#### Concrete implementation: one shared chat queue

Use a small in-process scheduler keyed by bot instance + guild + channel/thread as the coordination foundation. The existing `KeyedSerialQueue` provides serialization, but its promise chain has no priorities, batching, queue bound, or expiry; keep that primitive where useful and add these scheduling features in a focused chat-queue component.

- Buffer eligible events with author IDs, source message IDs, reply/reaction targets, timestamps, and origins. Update the bounded buffer cheaply; do not create a model job for every message.
- Run at most one conversational generation/delivery job per channel at a time, with a small global concurrency limit across channels. Preserve distinct discussion branches in context; serial scheduling does not mean merging unrelated topics.
- Prioritize substantive direct requests among waiting jobs. Batch nearby fragments, coalesce repeated equivalent pings from the same person, and allow at most one replaceable proactive candidate per episode within a bounded channel queue. Do not collapse different people's questions or repeated side-effect requests solely because the text matches.
- When a job starts, build its context from the latest relevant buffered events and existing memory retrieval. Evaluate reply/react/silence there. Keep substantive direct requests dependable; reserve optional silence for bare/repeated low-substance pings and proactive opportunities.
- Apply evaluation and output cooldowns inside the scheduler. Expire obsolete proactive candidates, recheck targets/game ownership before output, and drop excluded utility/game events before social scheduling. A new direct request can take priority over waiting optional work; it must not interrupt a tool action already executing.
- Keep the existing per-user memory mutation queue where needed for cross-channel consistency. Channel scheduling and memory write consistency are separate responsibilities; define their acquisition order to avoid queue deadlocks.

Start with local state and graceful shutdown; discard pending optional chat work on restart instead of replaying it. Distributed locks, durable chat-job queues, persistent cooldown recovery, and a new external queue service are optional future deployment requirements. Existing durable reaction watches still resume through their current scheduler, subject to the common eligibility checks and activity limits. Route all social triggers through the same chat scheduler so they cannot bypass each other's limits.

This queue is the main new coordination component. Shared audience assignment and accurate actor/target context remain focused changes to existing memory and context paths; serialization alone does not correct either.

Source anchors: [queue key](../src/application/chat/chat-conversation-service.ts#L638), [ignore branch](../src/application/chat/chat-conversation-service.ts#L846).

### High: utility output and D&D need one enforced boundary across all chat paths

Added requirement: social chat must not speak or react because of tool use, utility output, or replies/reactions to that output. A human replying to a link-fix message must not wake the character, including when Discord includes a bot mention in the reply. D&D-owned channels and their threads must never receive social-chat messages or reactions. These exclusions take precedence over personality, direct pings, participation presets, and activity settings.

Current protection is useful but incomplete. Direct and ambient paths check the existing game-channel guard, including thread parents; lookup errors fail closed. The delayed reaction scheduler does not receive or apply that guard. Reaction watches are already registered specifically for conversational replies, so ordinary link fixes and command output should not directly create a reaction follow-up today. Preserve that good restriction and extend it to every social path.

Link fixing posts a normal bot-authored reply without origin metadata. Channel-history selection keeps the bot's own messages as context without distinguishing utility output from character speech. Direct matching accepts a human message that mentions the bot without checking whether its reply target belongs to a utility interaction. This creates a route by which a reply to a link fix can enter chat. The reported live incident has not been replayed; the source establishes the missing distinction, not the exact deployed trigger.

Implement a common chat-eligibility policy and lightweight persisted message-origin tracking (a small record per relevant bot output, not a general event-sourcing system). Label messages by originating subsystem and purpose, for example conversational reply, link fix, command/tool result, system notice, and game output. Bot authorship alone is insufficient because one bot performs all these jobs. Store message IDs, channel/thread, origin, and interaction/episode linkage so classification survives restarts and works across reply-chain hops. For older messages, use known utility/interaction records where available and conservatively exclude ambiguous bot-owned reply targets rather than letting the model guess from prose or URLs.

Apply the policy before typing, model calls, chat tool execution, watch registration, and social memory updates. Recheck it immediately before sending text or applying emoji, since a queued action may become ineligible. The policy must cover direct, ambient, continuation, spontaneous, reaction-triggered, and history-reaction paths. Each reaction target needs its own eligibility check; an allowed source channel must not authorize a reaction on an excluded message. A fully ignored text result must not allow `historyReactions` to bypass the exclusion.

Tool execution retains its required functional output, such as a rewritten link, result card, or command response. Suppress additional character commentary, acknowledgments, and emoji about the execution; tool lifecycle events and result messages must not seed ambient participation or reaction watches. If a chat request executes a tool, deliver the required result without an added social follow-up. Distinguish this from a new standalone human conversation about a subject that happened to appear in a link: utility-interaction replies stay excluded, while a new eligible conversation is evaluated normally.

Use the campaign's authoritative channel/thread ownership lookup for the D&D exclusion rather than only matching channel names or scanning message content. Make this dependency available to the scheduler and delivery/reaction layer. Cancel pending social actions and close outstanding watches when their channel becomes game-owned; if ownership cannot be resolved, fail closed for chat. The game's own narrator, cards, and commands continue through their existing subsystem.

Source anchors: [game-channel guard](../src/infrastructure/discord/behaviors/game-channel-guard.ts#L8), [link-fix delivery](../src/infrastructure/discord/behaviors/link-fix-behavior.ts#L71), [history filtering](../src/infrastructure/discord/behaviors/chat-turn-support.ts#L181), [reaction-watch contract](../src/application/chat/message-reaction-watch.ts#L1), [scheduler wiring](../src/bootstrap/dependencies.ts#L666).

### Architecture and interface readiness

The existing behavior registry, conversation service, memory engine, tool registry, structured output, and settings registry are suitable foundations. The changes require a focused structural refactor: the current request assumes one `currentUser`, its action fields encode special cases for ambient triggers, and the same bot identity represents both character speech and utility messages.

Introduce three explicit application interfaces:

1. **Conversation context:** an episode/event with participants, speaker when there is one, reply/reaction target, provenance, and channel ownership. Reaction events should not require a fabricated speaker.
2. **Participation decision:** silent, react, reply, or both, with a compact reason, target, and expiry. Enforce utility/game exclusions before invoking this decision.
3. **Action execution and delivery:** authorized tool execution and eligible output, with freshness/ownership checks, deduplication, and functional-versus-social output separation.

Keep Discord handlers as adapters into these interfaces. Avoid duplicating the participation policy in every behavior or allowing a new spontaneous-reply path to skip exclusions. Add episode persistence alongside current state storage rather than replacing the entire memory repository.

The settings registry already shares read/write validation between slash commands and the settings panel. Extend it with a small set of understandable controls:

| Control | Proposed presentation |
| --- | --- |
| Participation | Only when addressed / continue conversations / occasionally join in. |
| Activity | Quiet / balanced / lively; documented presets governing proactive opportunities, not refusal frequency. |
| Reactions | Off / selective, with separate advanced limits if needed. |
| Channels | Where spontaneous participation is allowed; show D&D ownership exclusions explicitly. |
| Memory | Channel sharing/isolation and retention, preserving existing access rules. |
| Diagnostics | Admin-only proposed action/reason, exclusion reason, and effective configuration; support shadow mode. |

Keep cooldowns, thresholds, and per-path timing under advanced controls. Clarify that today's “ambient replies” only means name-triggered responses; migrate existing configuration predictably without silently enabling broad spontaneous chat. Keep translations, configuration defaults/validation, slash metadata, settings panel behavior, and documentation in sync. Existing upload rows remain slash-command based; action-level example authoring needs deliberate support rather than assuming the current text-exchange format can represent silence.

Utility/tool suppression and D&D exclusion are enforced routing rules, not optional personality settings. No participation preset, user customization, or permission to mention the bot should override them.

#### Feature controls through the existing settings/policy engine

Use the current settings registry, patch validation, configuration provider, and access-policy checks as the single configuration path. Both slash commands and the settings panel must read/write the same effective values. The chat scheduler consumes resolved policy; it must not maintain an independent collection of feature flags. Proposed labels below describe the intended controls, not already-existing commands.

| Feature | Control | Initial behavior and scope |
| --- | --- | --- |
| Chat | Existing master enable and allowed channels | Master off blocks every social-chat trigger. Existing access rules still apply. |
| Continue an active conversation without a ping | Separate toggle | Off until enabled; guild default with optional channel override. |
| Join a conversation spontaneously | Separate toggle plus allowed-channel selection | Off until enabled; independent of continuation and name-triggered ambient replies. |
| Respond to the bot's name | Existing ambient-replies setting | Keep its current meaning; enabling it must not silently enable all spontaneous participation. |
| React to human messages | Selective reactions toggle | Reuse/clarify history-reaction configuration as the implementation expands; independent of text participation. |
| Follow up when people react to the bot | Existing reaction-replies toggle | Independent of the bot placing its own emoji; use the same shared scheduler and exclusions. |
| Bare/repeated pings | Choice: brief acknowledgment / personality decides | Default to acknowledgment for a first bare ping; personality mode may choose silence or a reaction. Substantive questions remain dependable. Hard rate limits and duplicate suppression always apply. |
| Activity and cooldowns | Quiet/balanced/lively presets; advanced timing/budget values | Presets set explicit documented values. Show custom overrides and the resulting effective values; presets do not bypass access or exclusions. |
| Memory scope and retention | Existing per-channel memory modes and background-scan controls | Shared open-channel facts use the agreed default; isolated/session-only/disabled remain explicit choices. No per-person shareable flag. Scope changes do not silently migrate or delete historical records. |
| Evolving persona | Existing persona-drift toggle/reset | Independent from participation, shared memory, and cooldown settings. |
| Diagnostic capture / shadow evaluation | Restricted opt-in controls | Off by default; bounded retention and rate/cost limits. Preview decisions without posting. |

Reuse existing fields where semantics match. Introduce new fields only for genuinely distinct choices; in particular, distinguish responding to a name, continuing a conversation, spontaneous speech, outgoing reactions, and follow-ups to incoming reactions. The primary UI can offer a participation preset while advanced controls expose the independent features. Show dependency explanations such as “continuation enabled, but chat is disabled” or “excluded: D&D channel” instead of a toggle that appears to have no effect.

Resolve configuration in a clear order: mandatory utility/game exclusions and access restrictions; master chat enable; allowed channel; explicit channel feature override or inherited guild value; activity/capability limits. Channel overrides may narrow or tune allowed behavior but cannot bypass master-off, access denial, or mandatory exclusions. Keep hard provider/concurrency ceilings distinct from editable conversational cooldowns. The queue, attribution correctness, and public-fact audience assignment are implementation fundamentals, not features users should have to enable to fix incorrect behavior.

Apply settings changes to pending work: re-read relevant effective policy before model evaluation and again before text/reaction delivery; cancel newly disabled optional jobs and close ineligible reaction watches. If a call is already running, suppress disallowed social output without repeating or undoing completed tool actions. Disabling a feature must not drain a burst of previously queued replies. Memory-mode changes need their own documented read/write and historical-data semantics; a migration/backfill remains an explicit maintenance operation.

Ship configuration types/schema/defaults, update patches/provider persistence, registry entries, permission checks, translated labels/help, panel/slash rendering, and user documentation together. Existing deployments must not gain new unsolicited triggers from a schema upgrade. Test registry validation, both settings surfaces, inheritance/override precedence, unauthorized updates, backend persistence, and disabling a feature while its work is pending. Settings should accompany each feature's implementation rather than being deferred until all behavior work is done.

Source anchors: [request contract](../src/application/chat/chat-provider.ts#L8), [chat controls](../src/infrastructure/discord/settings/groups/chat.ts#L95), [memory controls](../src/infrastructure/discord/settings/groups/memory.ts#L15), [settings option contract](../src/infrastructure/discord/settings/registry/types.ts#L22).

### High: audit the actual model context and preserve identity/event relationships

Added requirement: review the exact context sent to the LLM, including who authored each message, whom it addresses, and who applied which emoji to which message. Identity errors can originate in collection, selection, summarization, or rendering; more identity instructions cannot restore evidence discarded earlier.

Current code already sends author IDs, message IDs, timestamps, and some reply-target metadata in channel history/reply chains. It explicitly warns against resolving identity by display name alone. However, `ChatUser` has only `id`, one selected `displayName`, and roles; it does not expose a consistent directory of username, global name, and server nickname. Recent exchanges render as generic `user`/`assistant` lines. The current-message block has a name and text without its own message ID/timestamp. Reaction summaries use emoji plus display names inside synthetic prose, with an ID/name list elsewhere. Ordinary channel-history records do not contain reaction actors. When a reply target is outside the fetched window/cache, `toChannelHistoryMessages` drops its known reference ID by taking the resolved target's ID instead of preserving the raw reference. These are concrete points to inspect and improve.

#### One account identity, several names

Treat the numeric Discord user ID (snowflake, stored as a string) as the canonical account key. Keep these fields distinct:

| Field | Scope and use |
| --- | --- |
| `userId` | Canonical account identity. Use for joins, authorship, mentions, and memory ownership; never parse as a JavaScript number. |
| `username` | Account username/handle. Helpful for recognition and explicit handle references; never use it as the database identity key. |
| `globalName` | Optional account display name. Preserve null when absent. |
| `guildNickname` | Optional nickname scoped to this guild. Preserve its guild association and null when absent. |
| `displayLabel` | Derived presentation label: guild nickname, then global name, then username, then an unresolved-ID label. It does not establish identity. |

Discord documents `id`, `username`, and `global_name` in the [User resource](https://docs.discord.com/developers/resources/user#user-object) and the guild-specific `nick` in the [Guild member resource](https://docs.discord.com/developers/resources/guild#guild-member-object). Names can change; current labels and historically observed labels must remain distinguishable. Do not infer a historical nickname from today's guild-member fetch.

Use observed alias records keyed to user ID, with source, guild scope where applicable, and observation time. Keep confirmed conversational nicknames separate from Discord account fields. An alias can map to multiple people; collisions and name reuse must not merge accounts. Resolve explicit Discord mentions directly by their IDs, and keep role/channel mentions typed separately. Bare names and pronouns are candidate references; ask briefly or leave unresolved when evidence is ambiguous. Identity linkage never grants access to another user's private memory or to another guild's context.

#### Participant directory plus linked events

Build one participant directory for people actually present in selected context: current speaker, reply authors/targets, reactors, explicitly mentioned people, and the bot. Include relevant memory subjects when needed. No full-server member dump is necessary. Optional compact references such as `u1` and `m1` must map deterministically to full account/message IDs for this episode/request, with the same map used across messages, reactions, memories, and summaries. Validate any model-provided references before translating them back to Discord IDs. Short references are presentation conveniences, not new persistent identities.

Illustrative model context, using invented labels and short references (the application retains exact Discord IDs):

```text
participants:
  u1: username="alex_fox", globalName="Alex", guildNickname="小狐狸"
  u2: username="riley_cat", globalName="Riley", guildNickname="貓貓"
  bot: kind=bot, displayLabel="松果"

messages:
  m1: author=u1, time=2026-10-14T12:00:00+08:00, origin=human
      text="我又忘記帶鑰匙"
  m2: author=u2, time=2026-10-14T12:00:10+08:00, replyTo=m1
      text="又來ww"

reaction_snapshot:
  target=m1, emoji="😂", actors=[u2], observedAt=2026-10-14T12:00:20+08:00
  complete=true, exactReactionTimes=unknown

current_event:
  type=message, author=u1, replyTo=m2, text="你笑什麼啦"
```

The model can now distinguish the person who forgot their keys, the person who replied, and the person who reacted. Emoji in message text is different from an attached Discord reaction. A laugh does not establish agreement, blame, or the reactor's involvement in the underlying event. The example format is a proposal; compare escaped structured JSON and compact typed text on actual attribution cases before choosing the final serializer.

Messages should preserve author, source message ID, sent/edited time when available, channel/thread, reply-target ID and resolution status, mentioned user IDs, attachment references, and subsystem origin. Preserve a reply target's known ID even if its content is missing; represent unavailable/deleted/not-fetched content explicitly. Pin the current event and its immediate target into the selection budget, then select the relevant branch and nearby participants. Deduplicate message IDs across reply chains and channel history. Do not drop an event's target while retaining a contextless reaction whenever an authorized bounded fetch can recover it.

Reactions should preserve target message ID, Unicode emoji or custom emoji ID/name, actor IDs, and whether the data is an add/remove event or a currently observed aggregate snapshot. Snapshot collection does not establish when each person reacted or the order of their reactions. Keep observation time distinct from event time, and mark incomplete lists/counts honestly. Fetch reactors only for relevant eligible targets within rate/cost limits; do not fetch every reaction in channel history. Recheck removals and eligibility before delayed action. Custom emoji names are descriptive hints, not reliable emotional classifications.

Keep account/message metadata application-authored. Escape names and all free text as data, including embedded delimiters/newlines; a nickname that resembles an instruction must not alter prompt structure. Separate author, quoted speaker, mentioned person, reply recipient, reactor, and subject of a memory. For summaries and stored facts retain source message IDs, who asserted the claim, who it concerns, and uncertainty. Known relationships from metadata must survive summarization rather than becoming guessed prose.

#### Verify the assembled prompt, not just the raw Discord event

Add an explicit, restricted diagnostic mode showing the bounded source events, normalized participant/event records, selected context, omitted/unresolved references with reasons, and final serialized model input. Capture only for authorized debugging, with redaction, limited retention, and no credentials or unrelated/private records. Use the same source IDs through each stage so a wrong answer can be traced to missing collection, dropped selection, lost summary attribution, ambiguous serialization, or model error. Record context/token budgets and truncation reasons alongside results.

Add fixtures for duplicate display names, renamed users, one account with all three name variants, missing nickname/global name, a reply target outside the history window, partial/deleted targets, quoted speech, multiple simultaneous topics, two people reacting to different messages with the same emoji, removed reactions, and custom emoji with the same name but different IDs. Assert actor/target linkage before scoring the generated answer. Include deterministic metadata checks and human-reviewed model attribution cases; do not rely solely on prompt-string snapshots.

Source anchors: [context serializer](../src/infrastructure/chat/chat-structured-output.ts#L454), [participant/history contracts](../src/application/chat/chat-provider.ts#L128), [reply-target extraction](../src/infrastructure/discord/behaviors/chat-turn-support.ts#L235), [reaction formatting](../src/infrastructure/discord/behaviors/reaction-reply-scheduler.ts#L44).

## 3. Proposed behavior

The event flow should be:

**Message/reaction → access and cost gates → conversation episode → participation decision → optional tools and character response → freshness check → delivery and memory updates.**

Use inexpensive local checks before a model call: allowed channel, bot/human author, recent activity, active conversation, repeated event, and participation budget. Evaluate plausible opportunities in batches. Do not run a full response/tool pipeline for every channel message.

The participation decision should return a compact action and reason category, target message/episode, and expiry. Useful categories include addressed question, ongoing exchange, relevant contribution, acknowledgment, repetition, and conversation moved on. Evaluate relevance, something new to say, character interest, interruption cost, recent bot activity, and relationship context. These are operational decisions, not a need to store a continuous stream of invented private thoughts.

### Direct pings and repeated pings

| Situation | Desired behavior |
| --- | --- |
| A substantive question or supported action | Usually answer or execute; use the character's voice. |
| One playful bare ping | A brief “蛤”, a reaction, or silence can fit. |
| Repeated equivalent pings in the same episode | Coalesce them; possibly one “有看到啦 別一直 ping”; then stop feeding the loop. |
| A new question after earlier ping spam | Reevaluate normally; no lasting grudge. |
| Retry after an error or missing delivery | Treat it as a legitimate retry, not evidence the person is annoying. |
| Serious or distressed conversation | Drop the irritated banter and respond appropriately. |

Track repetition using user + episode + recent equivalent intent, with short expiry. A bounded escalation might be notice → one boundary → temporary silence. Reset when the topic changes or the window expires. Do not store “this user is annoying” as a durable fact. Tone should depend on the persona and the user's teasing preference, not a universal insult template.

### Untagged participation and emoji

Start with continuing an exchange the bot is already part of. This is a clearer social signal than arbitrary cold interjections. Next, permit occasional participation in designated channels when the character has something relevant and distinct to contribute. A quiet channel by itself is not a reason to manufacture a topic.

Emoji-only participation should select a specific message for a specific reason. Keep it sparse, deduplicate reactions, respect topic changes, and avoid treating every compliment or laugh as a demand for acknowledgment. A delayed reaction should be canceled if it no longer fits. Persistent notification-producing follow-ups need a higher bar than a quiet reaction.

For a limited pilot, try a short burst-coalescing window, a brief continuation window, and a conservative per-channel proactive-message budget. Exact timings and rates are tuning hypotheses, not research-backed constants. Keep text and reaction budgets separate and make direct useful requests independent of the proactive budget.

### Cooldowns, batching, and model-call budgets

Added requirement: incoming messages must not each cause a model request, typing indicator, reaction, or reply. A send cooldown alone is insufficient if every message still incurs a full model call. Gate both evaluation and delivery, and keep observing eligible conversation events cheaply while the bot is silent.

Today's ambient handler has an in-memory per-channel cooldown, started when evaluation begins, including evaluations that ultimately ignore. That is a useful evaluation throttle but does not coordinate direct chat, reaction follow-ups, future continuation, or spontaneous participation. Replace these independent social throttles with shared, atomic reservations for model evaluation and outgoing activity. Preserve ordinary command access/rate limits separately.

| Layer | Purpose | Initial balanced-pilot hypothesis |
| --- | --- | --- |
| Eligibility | Exclude tool/utility interactions, game-owned channels, duplicate events, and disallowed channels before any chat work. | Always enforced; independent of cooldown. |
| Burst batching | Collect a small burst into one current episode snapshot instead of responding to every fragment. | Evaluate after 3–5 seconds of quiet, with a 10-second maximum wait so constant activity cannot postpone a candidate forever. |
| Evaluation cooldown | Bound model calls, including decisions that produce silence. | At most one proactive evaluation per channel every 20–30 seconds; no unbounded backlog of skipped evaluations. |
| Text cooldown and budget | Keep spontaneous contributions sparse across all social paths. | At least 60–120 seconds between unsolicited text contributions, capped at three per channel in ten minutes. |
| Reaction cooldown and budget | Permit quieter presence without an emoji on every message. | At least 20–40 seconds between proactive reactions, capped at five per channel in ten minutes; no duplicate reaction to a target. |
| Direct-request handling | Keep meaningful questions/actions usable while preventing repeated equivalent pings from multiplying work. | Separate bounded capacity; merge equivalent pending requests, retain a bounded queue, and use temporary per-user/per-episode repetition state. |
| Guild/provider budget | Protect total cost and concurrency when many channels are active. | Configurable evaluation/generation token or request allowance and concurrency cap; prioritize direct requests and shed optional proactive work first. |

These numbers are starting settings for measurement, not established best practices or values taken from the papers. Quiet/lively presets should change bounded opportunities, not bypass exclusions or guarantee an output frequency. An available budget means the bot may contribute; it is not a quota the bot must fill.

Track evaluation time separately from successful delivery time. Reserve capacity before a call/send so simultaneous triggers cannot both pass the same gate. Count every attempted model call against the cost budget; release output reservations on failure without treating the failure as social engagement. A decision to stay silent still consumes its evaluation allowance. Do not implement cooldown by sleeping inside a handler or accumulating one delayed task per incoming message.

Cooldown expiry must not automatically send an old reply. Keep at most one pending proactive candidate per episode within a bounded channel-wide limit, refresh or discard it when relevant messages arrive, and expire it when the topic changes or the contribution becomes stale. Recheck eligibility and context before delivery. For the initial single-process design, let the shared chat scheduler own local reservations and counters, discard optional pending work on restart, and avoid replaying stale bursts. Add shared locking/persistence only if multiple processes actually own the same bot/channel or durable scheduling becomes a requirement.

Model input should be a bounded relevant episode snapshot plus selected memories and tool results when needed. Do not resend the whole channel/guild history for every keystroke or message. Local gates and event buffering should happen before embeddings/retrieval/model calls for optional proactive work. Background durable-memory consolidation should batch separately and respect the same privacy/isolation rules. Skipped evaluations need no user-facing cooldown message; admin diagnostics can record why the bot stayed quiet.

### Personality and boundaries

“Mask under personality” should mean expressing a real limit naturally, without repeatedly discussing the machinery. It should not mean pretending an unavailable action happened or concealing a failure behind a joke.

| Situation | Example character behavior |
| --- | --- |
| Someone jokes “come eat with us” | “吃什麼 先給我看” can engage with the invitation without promising attendance. |
| Someone genuinely asks it to book a table | “訂位得你自己打啦 我這邊沒辦法打電話” states the specific limit once. |
| A supported music request | Perform it and deliver the functional result without extra character commentary or emoji about the tool use. |
| The same unavailable action is repeatedly requested | “這個還是辦不到啦” once, then disengage if nothing changes. |
| It does not remember | Brief uncertainty or authorized memory lookup; no invented shared past. |

Distinguish jokes, figurative affection, and fictional character expression from real-world commitments. Avoid interpreting every playful phrase as a literal request requiring a disclaimer. Keep the bot identity transparent when it matters or is asked about.

Use a smaller positive voice guide and balanced examples: ordinary conversation, useful answers, disagreement, brief limits, silence, emoji-only acknowledgment, and recovery after misunderstanding. Existing example exchanges teach text cadence; action-level examples need a schema that can actually represent silence and reactions. Do not add more refusal examples than normal successful interactions.

## 4. Research worth applying

| Paper | Relevant finding or design | Application here |
| --- | --- | --- |
| [Proactive Conversational Agents with Inner Thoughts — Liu et al., CHI 2025](https://arxiv.org/abs/2501.00383) | Studies proactive participation in multiparty text conversations; separates forming a contribution, evaluating its motivation, and deciding when to express it. | Closest match to this project. Evaluate whether a concrete contribution is worth making, rather than treating a ping/name/emoji as an automatic reply obligation. Use a compact, event-driven adaptation. |
| [Generative Agents — Park et al., 2023](https://arxiv.org/abs/2304.03442) | Uses observations, retrieved experiences, reflection, and planning to support believable behavior in a simulated town. | Ground continuity in shared episodes and cautiously derived summaries. Reflections should retain evidence and uncertainty. A simulated town is not evidence that nonstop autonomous chatter works in Discord. |
| [LongMemEval — Wu et al., ICLR 2025](https://arxiv.org/abs/2410.10813) | Evaluates extraction, cross-session reasoning, temporal reasoning, knowledge updates, and abstention; examines indexing, retrieval, and reading separately. | Test “what changed,” “who said it,” and “when” separately from basic recall. Diagnose missing evidence versus bad selection versus bad use of retrieved evidence. |
| [LoCoMo — Maharana et al., 2024](https://arxiv.org/abs/2402.17753) | Evaluates long conversations using question answering, event summarization, and multimodal dialogue tasks. | Borrow long-running conversation scenarios; add Discord-specific tests for overlapping conversations, reactions, and multiple speakers. Memory QA accuracy alone does not measure naturalness. |

These papers motivate experiments; they do not establish the best model, timing, prompt, or personality for this server. The proposed Discord architecture and rollout below are engineering recommendations, not claimed reproductions of the papers.

### Document research references alongside implementation

When the relevant features are implemented, add a concise **Research and design references** section to the README and link it to a maintained architecture/design document. Include each paper's title, authors/year, primary-source link, and the specific idea adopted or evaluation method borrowed. Use the four primary links above. Keep operational instructions and settings documentation linked from the chatbot section so readers can distinguish how to configure the bot from why it was designed this way.

The design document should map proactive participation to Inner Thoughts, episode/reflection ideas to Generative Agents where actually adopted, and memory evaluation to LongMemEval/LoCoMo where actually used. State adaptations and limitations, and link implemented modules and project-specific evaluation results. Describe the cooldown values as project tuning choices. Do not imply this bot reproduces a paper or achieves its published scores. Add citations with the implementation that uses them; leave unimplemented ideas in this review rather than advertising them as shipped README features.

## 5. Suggested build order

This is the single delivery sequence. Each row is a reviewable slice, not a separate infrastructure project. Reuse the existing memory engine and audience fields, settings registry/policy engine, structured action output, reaction watches, and queue primitive. No new vector database, distributed queue, or general autonomous-agent framework is required.

Before the first slice, record the deployed configuration and turn the reported failures into a small set of reproducible fixtures. Expand the conversation evaluation set as features land; collecting 50–100 cases is not a prerequisite for fixing known defects. The five existing suites already pass (105 tests); they are a baseline, not coverage of the proposed behavior.

| Order | Build | Ready when |
| --- | --- | --- |
| **1. Quick behavior fixes** | Add the missing D&D guard to delayed reaction evaluation and delivery; remove forced reactor tagging and pressure to acknowledge every reaction; ground the safety/capability prompt in actual enabled tools; preserve raw reply-reference IDs through rendering; replace the canned bare-ping invitation with a brief contextual response. | Regression cases cover the known leaks and prompt contradictions. Substantive eligible direct questions remain reliable. A bare-ping reaction can follow in slice 6 if the current direct-action path cannot deliver it correctly yet. |
| **2. Common eligibility and lightweight message origins** | Record whether bot output came from chat, link-fix, a tool, or another subsystem using existing persistence where practical. Apply one social-chat eligibility decision to entry, delayed work, delivery, typing, reaction targets, and relevant observation/extraction paths. Carry utility origin through reply chains; define a conservative fallback for unknown old bot output. | Tool/link-fix output and replies to it cannot trigger social chat, even with an explicit ping. D&D channels and child threads stay silent across all social paths. Functional tool results still work. Origin survives restart; policy changes invalidate pending output. |
| **3. Correct the context sent to the model** | Normalize existing message/reaction data around canonical Discord user IDs, separate name fields, message IDs, reply targets, reaction actors, and source channels. Use a bounded context renderer shared by direct and reaction turns. Keep known IDs when content is unavailable and mark unresolved references explicitly. | Fixtures show who said what, who reacted to which message, and what a reply references. Name changes/collisions do not merge people. Reaction turns no longer treat the bot as the human speaker. A compact participant directory is optional; the event relationships are required. |
| **4. Ship the complete public-memory lifecycle** | Centralize audience assignment in `resolveMemoryScope` after upstream validation, covering shared and isolated modes across live, dedicated, and background ingestion; derive ownership from the resolved scope. Independently skip reaction-turn extraction/synthetic proposal writes and reject bot-asserted durable upserts across all paths, including per-fact asserter overrides. Use configured modes for visibility and document admin setup for private channels. Update retrieval, search-result labeling, self-listing, conversational removal, and single-record forgetting together. Ship scope disclosure in the memory UI/replies and user guide before activation or backfill. Preserve existing forget-all protections. Reword extraction prompts around subject and evidence. Prepare a dry-run, idempotent migration for verified public sources. | Bob publicly says he likes apples; Alice can recall that after history eviction in an allowed shared context. Bob can list, correct, and forget it; old jobs cannot recreate it. Isolated records remain channel-local; unverifiable historical records keep their audience. Bot output/reaction notes cannot become confirmed shared facts even before slice 3 is implemented. Deploy compatible lifecycle code before running any backfill. No separate shareable flag or guild-topic workaround. |
| **5. Add the shared channel/thread queue and budgets** | Wrap the existing queue primitive with bounded pending work, priorities, a short event buffer, burst batching, expiry, evaluation cooldowns, separate text/reaction budgets, and a global concurrency cap. Route existing social triggers through it first. Keep memory-write locking with a defined lock order. | One conversational job runs per channel/thread; unrelated direct questions are not merged. Bursts do not cause one optional model call per message. Direct requests have bounded priority, stale work is discarded, and disabling a feature prevents pending delivery. Local counters/reservations are sufficient for the current single-process bot. |
| **6. Enable research-inspired participation** | Unify reply/react/ignore delivery; add temporary repeated-ping state, selective reaction follow-ups, then untagged continuation, then optional spontaneous contributions. Adapt Inner Thoughts into a compact contribution-and-timing decision using the bounded episode context and existing retrieval. | Bare/repeated low-content pings can receive a reaction or silence; substantive eligible questions remain dependable. Ignored turns do not execute tools or emit fallback text. Shadow evaluation and a limited channel pilot show relevant contributions, correct attribution, fewer pointless notifications, and bounded cost. |

### Settings and research ship with their feature

Do not defer settings integration to a cleanup stage. Each configurable slice must include registry/schema validation, persistence, policy resolution, translations, and equivalent slash-command/panel controls. Reuse existing controls before adding new ones. Memory scope accompanies slice 4; cooldowns and budgets accompany slice 5; continuation, spontaneous activity, and reaction controls accompany slice 6. Guild defaults and channel overrides resolve through the existing policy engine. Recheck effective policy before delivery. Utility/game exclusions, accurate attribution, and authorized memory access remain invariants rather than personality toggles.

Research is part of the build, not a distant follow-up: borrow LongMemEval/LoCoMo scenarios for slice 4; use evidence-linked episode ideas from Generative Agents where useful in slices 5–6; apply Inner Thoughts directly to slice 6. Add README references and the specific adaptation with the implementation that uses them. Start with one compact participation decision after cheap local gates; do not require a separate model call for every incoming event or reproduce an entire paper architecture.

### Why this order

The early slices improve behavior immediately and establish which events belong to chat and who they concern. Memory sharing then ships as a complete lifecycle instead of exposing records before listing/deletion work. The queue coordinates existing triggers before new triggers increase activity. Research-inspired participation uses those same interfaces, so it is an extension of the current bot rather than a rebuild.

The queue and memory work are largely independent once eligibility is settled and the memory slice independently validates human sources and rejects bot/synthetic assertions; their order can be swapped if traffic pressure is the immediate priority. Public-memory recall is a central reported problem, so memory precedes the queue in this sequence. Do not enable spontaneous participation before the queue, budget, and exclusion checks are in place.

The quote-card fix and proposed `quote_message` tool remain independent workstreams. The existing quote-card defect specification covers unbounded author/handle widths, unsplit long URLs/words, the fixed 300-character cut, and missing height validation at the 20px minimum font. Keep that detailed specification separate; these workstreams need not delay chat/memory work, but their output must use the common utility-origin classification.

## 6. Evaluation and review limits

Evaluate both action selection and the resulting message. Use sequence-level cases, not only isolated prompts:

- Repeated equivalent pings versus legitimate retries and genuinely new questions.
- A normal question, a harmless joke, an unavailable real-world action, and an enabled tool request.
- A laugh that ends an exchange; a contextually meaningful question-mark reaction; a reaction arriving after the room has moved on.
- Two users sharing one topic, and two unrelated topics interleaved in one channel.
- Old relevant memories, corrected facts, wrong-speaker traps, private records, isolated channels, and forgotten/deleted facts. Include synthetic reaction notes quoting bot text, main-response/dedicated/background bot-asserted proposals, and per-proposal asserter overrides: none may create a durable fact. Run these tests without depending on the slice 3 identity changes.
- Public preference handoff: xxx states an apple preference; yyy asks later in the same/another permitted shared channel, including after history eviction and nickname change. Verify original subject/source, uncertain third-party claims, correction, deletion, source-verified backfill, and isolation according to configured channel modes. Test that a permission-restricted but unlisted channel still resolves to shared; the admin disclosure must explain this first-release limitation.
- Silence and reaction-only turns, concurrent events, duplicate deliveries, and tools failing after acceptance.
- Replies to link-fix/tool/command output with and without a bot mention; multi-hop utility follow-ups; reactions on those outputs; no extra character commentary after chat-initiated tool execution.
- D&D Party/Adventure channels and child threads across direct, ambient, continuation, spontaneous, delayed-reaction, and history-reaction paths; ownership lookup failures; ownership changing while a reply is queued.
- Utility provenance surviving restarts; legacy bot-output fallback; chat history not mislabeling utility output as character speech; legitimate new standalone conversations remaining eligible.
- Equivalent settings through slash commands and the panel, preset migrations, and confirmation that personality/activity controls cannot override tool/game exclusions.
- Feature settings: independent continuation/spontaneous/reaction switches, guild inheritance and channel overrides, master-off/access precedence, persistence across restart, and mid-flight disabling without queued social output escaping.
- Message bursts and sustained traffic using a fake clock: bounded evaluation calls, independent text/reaction budgets, maximum batch wait, no automatic output on cooldown expiry, and no backlog replay after restart.
- Simultaneous direct/ambient/reaction candidates, atomic reservations, failed sends, and guild/provider exhaustion: no duplicate outputs; meaningful direct requests retain priority over optional proactive work.
- Model input and retrieval size under heavy traffic: only bounded relevant snapshots are sent, rather than every incoming message initiating full history/retrieval/generation.
- Identity/context cases: all Discord name variants, duplicate/reused/changed names, escaped nickname text, unresolved reply targets with preserved IDs, quoted versus authored speech, emoji in text versus reaction events, and incomplete reaction snapshots with unknown event times.

Track unnecessary refusals, appropriate silence, missed direct requests, contribution relevance, repeated phrases, attribution errors, stale interjections, notifications, latency, and cost. Have humans compare conversational sequences for voice and timing; do not optimize for message count or accept a model judge as the only measure. Use deterministic checks for access scopes, side-effect suppression, deduplication, and action expiry.

Existing relevant test suites were inspected: structured output, ambient behavior, reaction scheduler, conversation service, and memory channel policy. Initial sandbox runs failed before collection because Windows temporary-file renames returned `EPERM`. A subsequent normal run outside the sandbox passed all five suites, 105 tests total. The environmental failure is resolved for this baseline; these passing tests do not reproduce the reported live incidents or establish conversational naturalness. No live bot experiment was performed.

Follow the single build order in section 5: quick wins, common exclusions, attribution, complete shared memory, the bounded queue, then expanded participation. Settings, regression checks, and applicable research references ship with each slice. This document contains planning requirements only; none of these fixes has been implemented yet.
