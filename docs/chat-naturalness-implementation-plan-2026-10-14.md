# Chat naturalness implementation plan

Date: 2026-10-14 (Asia/Taipei).

Source: [chat naturalness review](chat-naturalness-review-2026-10-14.md), especially section 5, which defines the delivery order. This companion turns that order into implementation tasks, file boundaries, and acceptance gates. It is a plan only; no application behavior, configuration, saved persona, or live deployment has been changed.

## Delivery map

| Stage | Outcome | Dependency | Suggested review unit |
| --- | --- | --- | --- |
| 0 | Reproducible failures and current baseline | None | Fixtures and baseline notes |
| 1 | Fix known reaction, prompt, and reply-reference defects | 0 | Quick fixes |
| 2 | One social eligibility policy and persistent output origins | 1 | Policy, storage, adapters, and regressions |
| 3 | Correct actor, target, and source context | 2 | Context contract and renderer |
| 4 | Complete shared-memory lifecycle | 2; use 3 for context integration | Several internal reviews; one compatible lifecycle release before activation |
| 5 | Bounded channel/thread scheduler and episode buffer | 2–3; follows 4 in the chosen sequence | Scheduler, existing-trigger integration, and settings |
| 6 | Selective and expanded participation | 4–5 | Direct actions, reaction follow-ups, continuation, spontaneous participation |

Stages 4 and 5 can exchange order if traffic becomes the immediate problem. Stage 4's human-source guards must work independently of stage 3. Expanded participation must wait for eligibility, context, scheduling, and budgets.

## 0. Establish fixtures and baseline

1. Record the checkout and locally available configuration shape. Before rollout, obtain the actual deployed revision, provider/tool capabilities, and effective guild/channel settings; local defaults do not prove live behavior.
2. Add a small deterministic sequence fixture set for the known failures: reaction in a game-owned thread; ping replying to link-fix output; missing reply content with a known reference ID; Bob's public apple preference queried by Alice after history eviction; a reaction note quoting bot text; and a meaningful direct question.
3. Run the existing focused suites for structured output, ambient behavior, reaction scheduling, conversation service, and memory channel policy. Record current results rather than treating the review's historical 105 passing tests as a new run.
4. Use mocked providers and controlled time. Capture expected actions, provenance, model input, and side effects rather than only matching response prose.

**Done:** each failure has an expected invariant and an assigned later stage. A large naturalness dataset is not a prerequisite.

## 1. Quick behavior fixes

**Existing files:**

- `src/infrastructure/discord/behaviors/reaction-reply-scheduler.ts`
- `src/infrastructure/discord/behaviors/game-channel-guard.ts`
- `src/infrastructure/discord/behaviors/chat-turn-support.ts`
- `src/infrastructure/discord/behaviors/mention-chat-behavior.ts`
- `src/infrastructure/chat/chat-structured-output.ts`
- `src/application/chat/chat-provider.ts`
- `src/application/chat/chat-conversation-service.ts`
- `src/bootstrap/dependencies.ts`

**Tasks, in order:**

1. Inject the authoritative game-channel guard into delayed reaction evaluation. Check thread parents, fail closed on lookup errors, and recheck before text or emoji delivery.
2. Remove instructions to tag reactors and the preference for acknowledging every reaction. Use silence when no worthwhile continuation exists.
3. Preserve the raw Discord reply-reference ID when the target cannot be fetched; mark content unresolved instead of losing the relationship.
4. Generate capability wording from enabled tools and applicable permissions. Allow ordinary authorized requests while continuing to reject attempts to override authority or extract secrets.
5. Replace the canned bare-ping invitation with a short contextual acknowledgment. Defer reaction-only direct delivery to stage 6 if needed.

**Verification:** extend reaction-scheduler, structured-output, conversation-service, and chat-turn-support tests. A substantive eligible direct request still receives its normal functional answer; unavailable capabilities are described accurately.

**Release gate:** no delayed social output in D&D channels/threads, no compulsory reactor notification, and unresolved references retain their IDs.

## 2. Common eligibility and persistent message origins

**Proposed modules:** `src/application/chat/chat-eligibility-policy.ts` and `src/application/chat/message-origin-store.ts`. Names are implementation suggestions, not existing APIs.

**Integration points:** direct/ambient/reaction adapters, `chat-turn-support.ts`, `link-fix-behavior.ts`, tool/command delivery, reaction watches, context extraction, persistence factory, and bootstrap wiring.

1. Define output origins such as chat, link-fix, tool/command result, system notice, and game output. Persist message ID, guild/channel/thread, origin, and parent interaction or episode linkage using the existing persistence conventions.
2. Implement origin lookup in both active database backends. Plan schema migrations with the repository's existing migration workflow; test restart lookup.
3. Create one eligibility decision with a reason: ownership/access/master enable/channel rules, message origin, and utility reply ancestry. Unknown legacy bot reply targets are conservatively excluded; new standalone human messages remain independently eligible.
4. Carry utility origin through multi-hop reply chains with bounded traversal. Check each history-reaction target separately.
5. Apply the policy before typing, model calls, chat tools, reaction-watch registration, and social observation/extraction. Recheck effective policy before delivery; invalidate pending output and watches when ownership/settings change.
6. Keep required tool output working. A chat-initiated tool result must not gain extra character commentary, emoji, or social watches.

**Verification:** mentions on utility replies, multi-hop replies, reaction targets, restart provenance, unknown legacy output, ownership lookup failure, and ownership changes during a queued turn.

**Release gate:** every current social entry/delivery path uses the common decision; game and utility exclusions cannot be overridden by personality or settings.

## 3. Normalize and verify model context

**Existing files:** `chat-provider.ts`, `chat-state-store.ts`, `chat-turn-support.ts`, `reaction-reply-scheduler.ts`, `chat-structured-output.ts`, and their provider adapters.

**Proposed module:** `src/application/chat/conversation-context.ts`, with one bounded renderer used by direct and reaction turns.

1. Define message/reaction events independently of a required human speaker. Preserve author IDs, message IDs, timestamps, source channel, origin, mention IDs, reply targets, and resolution status.
2. Keep username, global name, guild nickname, and display label separate. Key identity by Discord ID. Observed aliases carry scope/time/source; collisions remain ambiguous.
3. Represent reaction actors and targets explicitly. Distinguish add/remove events from aggregate snapshots; include completeness and observation time without inventing individual reaction times.
4. Adapt existing recent exchanges/history/reply chains; pin the current event and immediate target, deduplicate message IDs, and select a bounded relevant branch. Do not invent absent historical metadata during conversion.
5. Remove the bot-as-human-speaker requirement for reaction turns. Preserve the original exchange relationship and participating humans without selecting an arbitrary reactor as the author.
6. Escape all free text as data. Compare structured JSON with compact typed text on attribution fixtures, then use one serializer consistently.
7. Add restricted, opt-in diagnostics for collection, selection, unresolved references, truncation reasons, and final serialized input, with redaction and bounded retention.

**Verification:** inspect the assembled provider request for changed/colliding names, escaped nicknames, missing targets, quoted speech, multiple reactors, and incomplete snapshots.

**Release gate:** each selected event retains who did what to which message; reaction context contains no fabricated human assertion.

## 4. Complete shared-memory lifecycle

**Core files:** `memory-channel-policy.ts`, `memory-engine.ts`, `memory.ts`, `memory-validation.ts`, both memory repositories, `chat-conversation-service.ts`, `chat-memory-policy.ts`, `personal-memory-extraction.ts`, `channel-summary-scheduler.ts`, the personal extraction queue, `memory-lookup-tool.ts`, `memory-command.ts`, and `member-profile-service.ts`.

Split development into these reviewable parts, but ship compatible management/read paths before activating sharing or backfill:

1. **Source safeguards:** skip reaction-turn dedicated extraction and synthetic-turn durable proposals. At the common durable upsert boundary, reject bot-asserted facts using the effective per-proposal asserter, including overrides. Verify live, dedicated, evicted-exchange, queued, and background ingestion separately. Synthetic notes and assistant quotations are not human evidence.
2. **Central scope:** after upstream validation/grounding, resolve eligible retained public self-facts in `resolveMemoryScope`. Shared mode allows guild-wide person/community facts and channel-local scene facts; isolated mode forces channel audience/isolation. Session-only/disabled retain their durable-write gate. Derive `ownerUserId` from the resolved audience, then use that same scope for canonicalization and persistence.
3. **Extraction contracts:** describe subject, assertion, source message/quote, and uncertainty consistently across prompts. Preserve the actual human asserter. Do not route preferences through the guild-topic validator or duplicate audience conversion in each extractor.
4. **Retrieval and listing:** query person facts by subject independently of audience. Update lookup result contracts and consuming prompts together. Self-profile lookup, `/memory list`, and member profiles include eligible subject facts with audience/evidence labels. Explicit mentions resolve by ID; ambiguous names do not guess. Alice asking about Bob does not confirm or adopt Bob's preference.
5. **Correction and deletion:** update/supersede the same scoped fact while preserving evidence/time. Add authorized subject-aware conversational removal and single-record forgetting in both backends. Bound deletion to the caller's rights and intended scope. Preserve forget-all cancellation of historical extraction and prevent queued work or derived summaries from recreating deleted facts.
6. **Disclosure and settings:** ship scope information in memory UI/replies and the user guide. Admins must review private/restricted channel modes before enabling sharing; unlisted channels still default to shared and Discord permissions do not automatically classify them. Document mode-change read/write behavior and historical-record treatment.
7. **Migration:** create a separate dry-run/apply maintenance operation with a reviewable report, stable eligibility criteria, and idempotent execution. Reclassify only records with verifiable original human evidence and admin-reviewed historical scope; leave unverifiable records unchanged and keep isolated facts local. Current visibility alone is insufficient evidence. Prepare operational recovery before apply; record changes without broadening older private data by a toggle.

**Acceptance sequence:** Bob publicly says he likes apples → Alice recalls it after history eviction and in another allowed shared channel → Bob lists it → Bob corrects it → Bob forgets it → old extraction jobs cannot restore it. Repeat with isolated, session-only, disabled, nickname change, third-party claims, and synthetic/bot evidence. Run the bot-source checks without depending on stage 3.

**Release gate:** compatible ingestion, retrieval, listing, correction, deletion, disclosure, and migration tooling are delivered together. Activate new sharing only after channel-policy review; execute reviewed backfill afterward as a separate maintenance step.

## 5. Shared scheduler, episodes, and budgets

**Existing foundation:** `src/application/concurrency/keyed-serial-queue.ts`, conversation service, state stores, ambient behavior, and reaction scheduler.

**Proposed modules:** `chat-scheduler.ts` and `conversation-episode-store.ts` under `src/application/chat/`. Keep the scheduler in process; use existing state storage for bounded episode continuity where appropriate, respecting retention and deletion policy. Pending optional jobs are not replayed after restart.

1. Key social scheduling by bot instance + guild + channel/thread. Run one conversational generation/delivery job per key and enforce a small global concurrency cap.
2. Add a bounded event buffer with separate discussion branches, participants, targets, active topic, unresolved questions, and recent bot actions. Observe eligible events even when the bot stays silent; durable fact retention remains a separate decision.
3. Add bounded priority queues, maximum wait, expiry, deduplication, and one replaceable proactive candidate per episode within a channel-wide bound. Prioritize meaningful direct requests; never merge unrelated people's questions or side-effect requests merely because text matches.
4. Route existing direct, ambient, and reaction triggers through the scheduler before adding new triggers. Define lock order with the per-user memory mutation queue; avoid awaiting a task that must reacquire a held queue.
5. Reserve evaluation/output capacity atomically. Count attempted model calls, including silent results; keep text and reaction budgets separate. Release failed output reservations without counting failed sends as social engagement.
6. Refresh or discard optional candidates when the topic changes, expire stale work, and recheck context/eligibility/settings before execution and delivery. Cooldown expiry alone never sends an old reply. A waiting direct request cannot interrupt a tool already executing.
7. Ship configuration, translations, panel/slash controls, effective-policy resolution, and diagnostics with the scheduler.

Starting tuning ranges from the review, to be measured rather than treated as established constants:

| Optional activity gate | Initial range |
| --- | --- |
| Burst quiet window / maximum batch wait | 3–5 seconds / 10 seconds |
| Proactive evaluation | Once per channel per 20–30 seconds |
| Unsolicited text | 60–120 seconds apart; at most 3 per 10 minutes |
| Proactive reactions | 20–40 seconds apart; at most 5 per 10 minutes |

These unsolicited-output limits do not randomly suppress meaningful direct answers. Hard provider/concurrency ceilings still apply; shed optional work first.

**Verification:** fake-clock bursts, sustained traffic, simultaneous triggers, bounded pending counts/input size, priority, send failure, policy changes, shutdown, and restart without stale replay.

**Release gate:** existing triggers share atomic limits and one channel execution lane; cost is bounded before optional retrieval/model work begins.

## 6. Selective participation, then new triggers

**Existing integration points:** structured output, conversation service, Discord delivery adapters, ambient behavior, reaction scheduler, settings registry, and provider parsers.

1. Define one participation decision: silent, react, reply, or reply-and-react, with target, compact reason, and expiry. Adapt provider parsing and delivery together. Decide before typing/tool execution; intentional silence must not become fallback text or a tool side effect.
2. Add temporary state for equivalent low-substance pings. Default the first bare ping to acknowledgment; allow the configured personality mode to select reaction/silence. Genuine new questions and legitimate retries retain dependable handling.
3. Make reaction follow-ups selective using the original episode, current topic, reaction removals, and freshness. Default to silence when a laugh ends the exchange; no automatic tagging.
4. Add untagged continuation behind its own default-off setting. Evaluate a concrete relevant contribution after cheap local gates, within the existing episode/scheduler budgets.
5. Add spontaneous participation separately, default off, restricted to explicitly allowed channels. Start with one compact contribution-and-timing decision rather than a model call for every event.
6. Ship independent feature switches and predictable preset migration. Existing name-triggered ambient settings must not silently enable continuation or spontaneous speech. Include action-level voice examples that can represent silence/reactions and successful tools; modify saved personas only as a separately authorized change.
7. Run bounded shadow evaluation, then an explicitly enabled limited-channel pilot. Compare conversational sequences for usefulness, voice, timing, attribution, unwanted notifications, missed direct requests, latency, and cost.

**Release gate:** silent decisions cause no unwanted side effects; new triggers are opt-in, relevant, correctly attributed, fresh, and budgeted. Human review accompanies deterministic safety/authorization checks.

## Requirements included with each stage

- **Settings:** when adding configurable behavior, include types/schema/defaults, update validation and persistence, registry, access checks, all supported translations, equivalent panel/slash controls, inheritance/overrides, and documentation. Resolve mandatory exclusions/access, master enable, allowed channel, feature overrides, then limits. Re-read policy before evaluation and delivery.
- **Tests:** extend focused behavioral and repository contract suites, then run the repository's typecheck, lint, migration checks, and broader tests as appropriate before a code release. Document environmental failures separately from application regressions.
- **Research documentation:** stage 4 adopts relevant LongMemEval/LoCoMo evaluation scenarios; stages 5–6 document evidence-linked episode ideas where used; stage 6 documents the compact Inner Thoughts adaptation. Add primary references and actual adopted methods to README and a maintained design document only as those features land. Verify paper details when writing those implementation citations.
- **Diagnostics:** restricted, opt-in, redacted, bounded records; no secrets or unrelated private evidence. Track attempted evaluations separately from delivered text/reactions.

## Recommended first implementation unit

Start with stage 0 fixtures and stage 1's delayed-reaction game guard, reactor-tagging removal, and reply-reference preservation. Those are bounded fixes with immediate regression coverage. Follow with capability-prompt alignment, then stage 2's persisted origins/common policy.

Keep quote-card layout fixes and the proposed `quote_message` tool as separate workstreams. Their outputs should use the utility-origin contract from stage 2.

## Completion status

Stages 0–6 now have implementation and regression coverage: common exclusions/origins, typed context, shared-memory lifecycle and reviewed backfill tooling, bounded persisted episodes and scheduling, and opt-in selective participation/settings. See [maintained design](chat-naturalness-design.md) and [server deployment instructions](chat-naturalness-deployment.md).

The live rollout gates remain pending: server channel-policy review, PostgreSQL/live Discord/provider checks, shadow evaluation, and human naturalness review. Restricted full-prompt capture and an action-aware uploaded-example format are not implemented; current fixtures and metadata diagnostics support initial review. Quote-card and `quote_message` remain separate workstreams. No deployment or production-data migration was performed locally.
