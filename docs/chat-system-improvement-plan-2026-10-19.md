# Chat triggers, context, and behavior improvement plan

Status: Phases 1–3 implemented and verified locally. Phase 4 is in progress with effective-policy and protected message-explanation views. Phase 3 provides an opt-in guarded text path; unavailable source classes are excluded and reported. Phase 5 and universal privacy-gateway enforcement remain pending; no deployment performed. Prepared 2026-10-19.

### Implementation progress — 2026-10-19

Phase 4 settings/explanation checkpoint: added the read-only `/settings-participation policy` report for an exact channel/thread, with trigger, context, and activity views. Resolved dependencies, inheritance/overrides, guarded exclusions, history access, and unknown readiness are explicit; report reads require fresh viewer access. Existing owner-only `/diagnostic message` lookup now gives a localized evidence-based explanation before its bounded timeline, preserving failure/fallback and incomplete-record distinctions. No access scope or live configuration changed. See [the Phase 4 checkpoint](phase-4-settings-explanation-checkpoint-2026-10-19.md) for coverage and remaining delivery/admin/self-service work. Validation: **4,640 passed / 7 skipped**, typecheck, changed/new-file lint, registry/metadata checks, and whitespace checks passed.

Phase 3 completion: all seven interactions share a registered guarded context lease for current text, reply ancestry, compatible fragments, count-first eligible history, verified new bot text, same-owner sessions, and eligible reactions. Fresh access/source checks, persistent forget cutoffs, complete text provenance, bounded backward retrieval and work deadlines protect each activated source. Provider retries, decision fallback, attribution repair, reactions, and delivery parts revalidate the lease. Memory, summaries, learned character state, images, and tools remain excluded and reported; universal gateway migration is separate. The default remains `legacy`; the localized settings choice exposes opt-in `eligible_count` with context enabled. See [Phase 3 acceptance](phase-3-context-acceptance-2026-10-19.md) for the source inventory, seven-mode matrix, bounds, invalidation lifecycle, exclusions, and rollout limits.

Final Phase 3 validation: **4,607 passed / 7 skipped**, TypeScript typecheck, changed/new-file ESLint, migration portability, and whitespace checks passed. Repository-wide ESLint has existing failures outside this change. SQLite acceptance includes cross-owner cleanup with guild isolation, reactor/audience dependencies, empty sessions, and primary cleanup despite context invalidation failure. Live PostgreSQL, provider quality, Discord pilot, deployment, and Phase 4–5 remain pending. Earlier Phase 3 checkpoint descriptions below are historical and superseded by this completion entry.

Phase 2 routing checkpoint: added the shared seven-interaction trigger contract, separate response/discussion identities, explicit mention precedence over a human reply target, and one-hop same-channel ping-disabled reply resolution with a 1.5-second bound. Uncached target fetch requires the existing feature/user/channel/game gates; fetched content is not forwarded by routing. Explicit/name-address turns retain scheduler priority regardless of bare-ping silence preferences. Verified with 53 trigger/routing/addressing regression tests, typecheck, and changed-file lint. Decision ownership and contextual response migration remain in progress.

Phase 2 engine checkpoint: `ConversationDecisionEngine` now owns participation admission and generated action validation. Character hooks no longer veto accepted decisions. Generation metadata distinguishes contextual answer/clarification from purely social/closing silence; short text no longer removes capabilities or permits silent failure. Clear name addresses share explicit-request priority/error handling, and incidental mentions remain optional. Repeated social pings are suppressed after contextual interpretation, so a new substantive request is not hidden by its final ping. Decision calls have a 12-second overall / 6-second per-endpoint bound, one configured repair/fallback, abort propagation, and a three-failure/30-second circuit cooldown. `continuationFailureMode` defaults to `strict`; opt-in `grounded_fallback` requires a current same-person proven branch, retains failure status, disables tools/search/images, and is revalidated before delivery. Provider health and cached synthetic checks are separate from reply-generation health. Focused engine/conversation/runtime tests pass; final regression/acceptance review follows.

Engine checkpoint validation: full suite **4,522 passed / 7 skipped**, TypeScript typecheck and changed-file ESLint passed. Includes real runtime/conversation fallback integration, contextual ping capabilities, invalid evidence, bounded stalled attempts/circuit recovery, transport budget propagation, owner-only synthetic diagnostics, and explicit-name error handling.

Phase 2 acceptance review: source/target/recipient grounding is shared between proposal validation and the engine, so labelling an ungrounded proposal “valid” cannot authorize group output. Final admission follows character postprocessing, and the legacy participation view consumes the engine's result. Gate ownership, all seven interactions, settings migration, failure recovery, synthetic health checks, rollout limits, and rollback are documented in [Phase 2 acceptance](phase-2-routing-decision-acceptance-2026-10-19.md). Phase 2 is complete locally; real-provider evaluation/deployment remain pending, and older-message retrieval/context parity remain Phase 3 work.

Final Phase 2 validation: full suite **4,529 passed / 7 skipped**, TypeScript typecheck, changed-file ESLint, and whitespace checks passed. Final grounding/recovery cases additionally prove that unapproved targets/evidence/recipients cannot authorize spontaneous output and grounded recovery cannot become social/closing/contribution output instead of an answer or clarification.

Implemented locally:

- A typed, runtime-validated diagnostic event boundary with allow-listed fields and safe failure categories. Diagnostic events omit raw message/prompt/response/error content. Production exception serializers omit messages/stacks/bodies/causes; legacy shadow-reason and attachment-content logging in the chat path were removed. This is not a repository-wide audit of unrelated feature logs.
- Gateway receipt and terminal events cover readiness/control-channel handling and reaction partial resolution; dispatcher child spans record receipt, matched behaviors, stop/failure, and completion. Direct-chat early exits identify disabled chat, duplicate requests, game-channel exclusion, denied access, unavailable providers, and unresolved reply origins.
- Async trace/span IDs shared through existing Pino child loggers; per-instance/process-run fields; submitter context retained across scheduled and buffered jobs.
- Decision attempt records distinguish provider/HTTP/timeout/JSON/schema failures and invalid target, fixed target, boundary, evidence, contribution, thought, and recipient validation. Successful fallback preserves earlier failed-attempt metadata. HTTP decision errors preserve status without exposing response bodies.
- Reply-chain/history fetch coverage, eligibility denial reasons, merged context counts, and character-context omissions by window, gap, segment, count, budget, or scope.
- Model operation outcomes for reply, participation, and attribution repair; turn completion and delivery status with confirmed part counts, including partial delivery.
- Scheduler job IDs and one terminal disposition per job distinguish replacement, direct-request preemption, channel/global queue limits, evaluation cooldown/budget, expiry, shutdown, execution suppression, and errors. Queue wait time is recorded without logging internal queue keys or content.
- Buffered opportunities carry stable IDs and links between replacements; cancellation is recorded on the original opportunity's trace with addressed-request, privacy, source invalidation, capacity, or shutdown reasons when known.
- Text/reaction reservations record admission, in-flight/cooldown/exchange/channel limits, and idempotent success/failure release. Completion events stay on the reserving trace even when released by a different caller. A committed reservation means the caller reported success, not an independent Discord receipt.
- Conversation events identify duplicate-ping suppression, unavailable optional decisions, and known delivery vetoes (privacy version, stale context/opportunity, shadow mode, caller cancellation, or output capacity) separately from model-generated silence.
- A per-instance file-backed diagnostic store retains validated metadata for 24 hours. Defaults cap retained source groups at 1,000 globally / 200 per guild, events at 20,000 globally / 200 per source group, and serialized event payloads at 4 MiB. Snapshot framing has a separately bounded overhead. FIFO eviction, missing prefixes, and per-trace truncation are reported; counters describe the current process run.
- Pino child loggers inherit the instance's retention sink without a global subscriber; retention is independent of stdout log level. Disk snapshots are debounced, serialized, atomically replaced, bounded on restore, and periodically pruned. A crash can lose the unflushed tail; persistence failures back off and report safe health metadata while the in-memory store remains usable.
- `/diagnostic message:<message ID or same-channel Discord link>` gives an owner-only ephemeral timeline, including lookup by a recorded bot delivery ID. It refreshes viewer/bot channel and history permissions before reading records, rejects cross-server/channel links, preserves the latest outcome in shortened output, and describes missing records without claiming the event was never received. The new option becomes available through normal command deployment/startup, not by editing these files alone.
- Message edits/deletions and conversation forgetting invalidate retained source metadata; pre-invalidation scopes cannot recreate removed traces through late callbacks. User forgetting conservatively clears the guild's diagnostic cache because records can involve several participants. Retention opt-out member cleanup includes diagnostics; diagnostic persistence failure does not prevent primary member/session cleanup from being attempted, and incomplete cleanup is surfaced.

The event schema uses `chat.route.matched`, `chat.dispatch.completed`, `context.source.selected`, `context.selection.filtered`, `model.decision.attempt`, `model.provider.attempt`, `model.operation.completed`, and `chat.model.completed` in addition to gateway/turn/delivery events. The longer catalog below is the target, not a claim that every proposed event name is emitted. Fallback chains trace each configured-model attempt and explicit stream retry; SDK-internal HTTP retries remain opaque. `no_text_delivery` is intentionally observational and must not be interpreted as proof of deliberate silence or a confirmed reaction.

Gateway checkpoint: message and reaction receipt now starts before startup/control-channel/partial-resolution handling, with one terminal outcome for those paths and inherited dispatch traces. Receipt includes an effective guild-policy fingerprint and validated BUILD_SHA/GIT_SHA (explicitly `unknown` when unavailable). Policy fingerprints describe the configured profile, not live Discord permissions or per-user privacy state. Verified with typecheck and 23 gateway/readiness/dispatcher/retention tests.

Provider checkpoint: bootstrap wraps every chat/utility/decision/embedding capability without changing optional capability availability. Operations emit safe completion/failure metadata; fallback chains emit each attempt, stream retry, and cooldown skip. OpenAI Responses and Gemini tool boundaries distinguish completion, unknown tools, invalid JSON arguments (Responses), failure, and timeout. Completion means a tool returned, not that its business action succeeded. Background summary/extraction scopes retain guild/channel or batch attribution where available; standalone calls without a message remain log-only. Production error serializers omit exception messages, stacks, causes, and response bodies. Verified with typecheck, changed-file lint, 77 provider/fallback/summary tests and four real tool-boundary tests.

Final Phase 1 checkpoint adds process-local invalid-event/unscoped/retention-exception/log-exception counters to `/diagnostic`, bounded 60-second Discord rate-limit aggregation with caller/channel/message attribution where available, and persisted restart reconciliation for prior-process spans/jobs/opportunities missing terminal events. Aggregates deliberately carry no individual request trace. Common text/reaction delivery, image previews, and control-panel edit slots have caller tags; uninstrumented paths remain `unknown`. Overflow folds into one mixed bucket; proactive waits and HTTP 429s remain distinct within normal buckets. Startup reconciliation marks incomplete evidence without asserting delivery failure or replaying sends.

Phase 1 acceptance and operational limits are recorded in [the acceptance checklist](phase-1-diagnostics-acceptance-2026-10-19.md). Wider administrator/self-service views and localization remain Phase 4 work. Some downstream execution checks still report generic operation suppression; do not infer a more specific cause where one is not recorded. The unified decision engine, count-first retrieval, privacy gateway, and expanded source policies are not implemented by these diagnostics checkpoints.

Final validation: full Vitest suite **4,481 passed / 7 skipped**, TypeScript typecheck and changed-file ESLint passed. Final shutdown-lifecycle checks additionally cover ignoring late observations after the rate-limit collector closes. Phase 1 is complete locally; deployment/pilot verification is still pending. Next is Phase 2's unified routing/decision contract, with source-specific privacy prerequisites retained for Phase 3 context expansion.

Local verification: full suite passed with 4,411 tests and seven environment-dependent skips; type checking and changed-file ESLint passed. A subsequent added window-versus-gap diagnostic regression passed with the 55-test character-runtime suite, and that changed test file passed ESLint. Test temporary files were placed under `node_modules/.test-tmp/chat-diagnostics` to avoid the earlier Windows temp rename failure. No live production incident reproduction is claimed.

Scheduler diagnostics checkpoint verification: full suite passed with 4,426 tests and seven environment-dependent skips; type checking, changed-file ESLint, and diff whitespace checks passed. New tests cover queue ownership and replacement, preemption, capacity, evaluation budgets, expiry, shutdown, operation errors, opportunity coalescing, reservation release/quotas, and conversation suppression causes. Each completed checkpoint is committed, as requested; the first diagnostics checkpoint is `49feee2b`.

Retention/lookup checkpoint verification: full suite passed with 4,456 tests and seven environment-dependent skips. A final bounded-flush regression and related suites passed with 125 tests after tightening snapshot coalescing. Type checking, changed-file ESLint, and whitespace checks passed. Coverage includes exact lookup scope, current viewer/bot permissions, restart/expiry, capacity and byte caps, safe corrupt-file handling, write failure/retry, old-snapshot deletion races, late callback invalidation, independent instance sinks, and preserving primary cleanup on diagnostic disk failure. Traditional Chinese and Japanese descriptions were added for the new slash-command option. Source-edit invalidation updates memory immediately and uses debounced snapshots; explicit forgetting waits for its snapshot revision to be persisted.

### Phase 3 historical checkpoint: eligible channel history

The shared channel-history collector now supports count-first retrieval: at most three pages / 300 raw messages, exclusions do not consume X, and selected messages retain chronological order. All seven interactions reach this collector through the mention, ambient/optional, and reaction adapters. The new mode does not discard messages because of their age, a quiet gap, or a model-proposed topic boundary. Count and prompt budgets are separate; all candidates remain verbatim when they fit, otherwise content is fairly truncated with an explicit prompt marker while retaining identity/time/reply metadata.

Historical eligibility is separate from passive observation. Admitted historical reads resolve same-channel reply origins with a shared 20-fetch budget per collection; passive observation remains cache-only. Historical origin-store errors fail closed. Revalidation forces source-message reads, rechecks access/scope/origins before model use and delivery, and suppresses output when selected evidence changes. Its per-turn refresher is capped at 12 passes / 600 source-message checks and an additional shared 20 ancestry fetches. These are work bounds, not latency guarantees.

The new mode excludes bot-authored channel-history messages without complete dependency provenance and does not merge legacy bot episodes. It also avoids importing reply-author names from unselected cached targets. It does **not** yet migrate session transcripts, reply-chain/overflow sources, durable memories, daily summaries, learned character state, or tools to the mandatory gateway. Existing direct/session/memory behavior remains on its current boundaries. Therefore this is a collector checkpoint, not completion of the source privacy contract or Phase 3.

Rollout is deliberately off by default: `character.context.retrievalMode` defaults to `legacy`. `eligible_count` plus `character.context.enabled=true` selects the new path in local/synthetic evaluation. Existing profiles keep their behavior. Do not enable the new mode for a production pilot until the remaining source gates and acceptance cases below are implemented. The public settings UI has not yet been extended for this experimental mode.

Content-free events now report raw fetched/examined/eligible counts, pages, selected message IDs, exclusions, filled/end/scan-cap/fetch-failure/no-progress outcomes, prompt truncation/budget counts, and refresh/change/budget exhaustion. They contain no message bodies, author labels, or provider error text.

Checkpoint verification: full suite **4,549 passed / 7 skipped**, TypeScript typecheck, changed-file ESLint, and whitespace checks passed. Synthetic tests cover paging past unreadable authors, count/size separation, old timestamps, oversized/escaped content, guard absence, warm/cold origin resolution, scope/unknown-origin rejection, and suppressing delivery after source access changes. No live-provider or deployed Discord validation is claimed.

Work outstanding at this historical checkpoint (resolved for activated text sources by the completion entry above; other sources are explicitly excluded):

1. Known dependency metadata now persists for confirmed bot output and session exchanges, but complete source coverage is not yet certified. Implement guarded assembly, derived-source revalidation, and invalidation after deletion/forgetting/access changes. Audit memory/summary/character/tool sources before enabling their expanded reuse.
2. Unify reply ancestry/overflow and current burst under the same guarded assembly, including current-member resolution, source-specific omission reports, and coverage parity across all seven interactions.
3. Add a request-wide historical deadline and efficient revalidation, bounded targeted backward expansion, shared decision/answer grounding projections, and source-priority budgeting.
4. Exercise the complete warm/cold-cache, long-gap, contextual bare-ping/personality, reaction, and permission-change matrix; then decide migration defaults and settings presentation. Full gateway enforcement remains tracked separately in the privacy-gateway plan.

### Phase 3 historical checkpoint: derived-source dependency metadata

New chat replies capture a bounded, versioned manifest of known message dependencies (IDs, source scope, author IDs, timestamps and hashes of the supplied text representation). The manifest contains no message bodies, display names, prompts or reply text. Disabled/session-only channels do not create durable manifests. Every capture is explicitly **partial**, with unresolved assembly coverage; it does not assert that session, memory, summary, image, tool or character inputs are fully covered. Missing scope, conflicting observations and the 128-dependency cap are recorded. The runtime schema also caps serialized metadata at 48,000 characters and rejects malformed/unknown fields. These manifests are persistent source metadata, not diagnostic log payloads.

The application assigns manifests after generation/postprocessing and overwrites any provider-supplied provenance. Confirmed Discord delivery parts bind the manifest to their actual content hash independently. Session exchanges preserve delivery IDs and bind the manifest to the actual stored assistant prefix, with current guild/channel/user audience checks. Bot origin stores preserve guild/channel scope. Complete proofs cannot be rebound to different output. Both persistence backends preserve optional dependency metadata; invalid metadata normalizes to null, and existing rows remain unverified. Additive PostgreSQL/SQLite migrations introduce the nullable origin column; no active database was migrated or deployed by this work. SQLite fresh-start/restart and upgrade-from-the-previous-schema cases pass locally.

The eligible-count path now excludes session exchanges before prompt selection, memory recall context, and persona selectors, with a content-free `context.derived.excluded` count/reason. All stored session text remains excluded on that path until a guarded source validator exists, even if metadata happens to parse. Bot-authored historical output remains excluded too. Legacy mode retains its existing session behavior. Merely recording dependencies does not grant permission to read or disclose them.

Dependency metadata is budgeted separately from transcript text, so adding source manifests does not silently reduce the existing eight stored / four prompted exchange limits. Session metadata remains bounded by eight exchanges times the per-manifest cap; delivery ID lists are separately bounded to 32 unique IDs. Summarizers receive their existing text projections rather than the dependency manifests.

Verification: full suite **4,564 passed / 7 skipped**; TypeScript typecheck, changed-file ESLint, migration portability check, and whitespace checks passed. Synthetic cases cover provider-proof replacement, dependency dedup/conflicts/caps, no raw-content capture, audience mismatch, binding individual delivery parts and stored prefixes, malformed metadata, session prompt exclusion, restart/schema upgrade, and disabled/session-only retention. Live PostgreSQL/provider/Discord behavior has not been evaluated.

At this checkpoint, guarded assembly and complete source closure remained unfinished. The completion entry and acceptance document above now supersede that status: verified text bot/session reuse is restored; unverified overflow summaries and other unavailable classes remain excluded. The new retrieval mode stays off by default.

## 1. Objective and evidence

Make the bot predictable when directly addressed, capable of following a conversation without repeated tags, and selective when joining other people's conversations. Every unexpected silence or missing-context result should be diagnosable from a message ID.

This plan builds on `chat-participation-implementation.md`; it does not assume those earlier controls should be removed. The current checkout and supplied production logs are the baseline. The deployed revision and database-backed effective settings still need verification.

Confirmed in the supplied Pinecone logs:

- At 12:26:06 and 13:02:43 Taiwan time, follow-ups were classified as `continuation`, with local recipient `continuing`, but the decision failed with `no_valid_decision`. Text capacity was available. These were failures to obtain a valid decision, not valid decisions to stay quiet.
- The 12:25 response had five channel-history messages. The 13:02 response had zero channel-history, zero reply-chain, and zero previous user-exchange messages.
- The unanswered direct tags in the screenshot have no matching request-start entries in the supplied excerpt. Their exact failure point is unknown.
- The PATCH 429 burst occurred hours earlier. Its originating feature cannot be identified from the redacted route alone.

Hypotheses to verify, not established causes: decision endpoint failure, invalid structured output or grounding IDs, context age/gap filtering, role eligibility, unresolved reply origins, or earlier routing suppression. Section 9 (Phase 0) ties each one to the code path that would produce it and the check that confirms or rules it out.

Already landed: commit `82026544` logs optional-decision rejection reasons from `optionalParticipationRejection`. It does not split the `no_valid_decision` bucket, which still covers every case where the decision is `null`.

## 2. Current system map

The request type currently has five modes: `direct`, `ambient`, `continuation`, `spontaneous`, and `reaction`. Observation is an input activity, not a sixth reply mode. Bare pings and replies to other humans containing a bot mention are variants of `direct`.

| Mode / event | Current entry condition | Current context | Current behavior / limits |
| --- | --- | --- | --- |
| Direct bot mention | Discord user mention includes this bot | Current message, eligible reply chain, filtered channel history, current user's session, authorized memory | Direct response path; access and eligibility still apply; optional participation failure is not the same gate as continuation |
| Explicit reply to bot | Reply target resolved as this bot, including supported ping-off replies | Same sources as direct mention, with reply ancestry | Routes through `direct`; unknown uncached targets can fail to match if persisted origin is unavailable |
| Bare ping | Direct message content is empty or a short greeting; no reply target or image | Available direct context | Default acknowledgment; configured personality mode can allow silence; repeated-ping protection also applies |
| Name address | Configured name or live nickname recognized as an address, without a Discord mention | Eligible reply chain, channel history, session, memory | `ambient`; requires ambient feature/access and its cooldown; may reply, react, or ignore |
| Implicit follow-up | Same person in a recent eligible uninterrupted bot exchange, no direct/name trigger | Observed episode plus current burst, fetched history, session/memory, any eligible reply chain | `continuation`; enabled explicitly; structured participation decision required; failure means silence |
| Open group conversation | Eligible content outside a recognized continuation | Eligible observed burst and channel context | `spontaneous`; requires observation scope and spontaneous allow-list; accumulation, pause, decision, and quotas |
| Reactions to a bot response | A watched delivered message receives reactions | Watched response, reaction participants, reply ancestry, current channel history | `reaction`; delayed evaluation, distinct eligible reactor threshold, feature/access checks; can reply/react/ignore |
| Ordinary channel message | Observation eligibility passes | Adds an event to the channel episode | Observation alone does not authorize a reply or unrestricted long-term memory |
| Tool / utility / game traffic | Origin and channel ownership rules | Separate feature context | Social chat excludes utility interactions and narrator-owned game channels |
| Scheduled scans / daily summaries | Separately selected scan/summary channels | Authorized background history | Separate from social triggers; does not grant social reply scope |

Message behavior priorities: trap channel 200, spam guard 150, observation 110, mention 100, ambient 90, proactive 80, link fix 50. Trap channel and spam guard run before any chat behavior and can stop propagation, so incident tracing must cover the entire dispatcher. Reaction arm (100) listens to reaction events, not messages.

Current defaults and constraints (effective guild/channel overrides may differ):

- Continuation window: 120 seconds after a confirmed response, tied to an engaged human and branch. Human interleaving, changed recipient, or a closing can end it.
- Continuation and spontaneous participation default off. Spontaneous requires its own channel list; observation uses exact channel/thread IDs.
- Balanced continuation limits: 15-second interval, 10 replies per exchange, 30 per channel per 10 minutes. Quiet: 30 seconds, 6, and 15.
- Spontaneous decision accumulation defaults to five messages; speaker turns or a substantive message can also schedule evaluation. Pause and coalescing delays are distinct from output cooldowns.
- Optional decision confidence floors are 0.7; contribution thresholds default to 0.5 continuation and 0.75 spontaneous. These are uncalibrated model judgments.
- When character context is enabled: default 15-minute window, 10-minute gap, 40 messages, 12,000-character budget, and 10 decision messages. A stale last event can produce an empty context. When disabled, selection takes a different bounded path; do not report the enabled defaults as universal live settings.
- Explicit reply context: up to five hops / 4,000 characters, with separately bounded older overflow for summary. User sessions are scoped by guild, user, and channel; another user's session is not inherited.

## 3. Proposed architecture and ownership

Use one shared evaluation pipeline with adapters for messages and reactions:

1. Normalize event and identity: source ID, actor ID, channel/thread, explicit mentions, reply target, attachments, timestamps, and output origin.
2. Resolve effective policy once and attach its version: interaction access, context access, passive scope, feature flags, limits, and memory mode.
3. Classify trigger deterministically where evidence is explicit. Preserve all evidence rather than overwriting a mention with reply metadata.
4. Resolve eligible context through a shared context builder, recording inclusions and omissions.
5. Decide participation only when needed. Explicit requests do not need permission from a speculative contribution score.
6. Generate a response using the selected context and allowed capabilities.
7. Recheck source freshness, access, settings version, branch, and capacity before delivery.
8. Deliver once, record proof, then commit session/episode updates and continuation state.

Suggested contracts: `TriggerResolution`, `EffectiveChatPolicy`, `ContextSelectionReport`, `ParticipationOutcome`, and `DeliveryOutcome`. Extend the existing scheduler, conversation service, and eligibility service rather than introduce a competing framework.

Separate policy decisions:

- `canInteract`: may this actor invoke the bot here?
- `canReadContext`: may this particular source be supplied for this request?
- `canObservePassively`: may the bot collect ordinary channel events here?
- `canPersistMemory`: may information be retained, and with what audience/retention?
- `canDeliver`: is this response still authorized and current?

Initially preserve existing access boundaries. Do not broaden readable members/channels implicitly during refactoring. Any new direct-context scope is explicit, defaults to existing behavior, and is shown in settings. Owner interaction bypass must not imply passive reading bypass.

## 4. Target trigger and response contract

| Situation | Proposed outcome | Failure behavior |
| --- | --- | --- |
| Authorized substantive @bot request | Answer or ask a necessary clarification | Visible concise error when generation fails; diagnostic reason for suppression |
| Reply to a known bot chat message, ping on or off | Treat as direct | Bounded same-channel target resolution; distinguish deleted/unreadable target from non-bot target |
| Reply to human + @bot | Bot is addressed; human message is the subject | Do not classify it as addressed elsewhere merely because the reply target is human |
| @bot plus another person mention | Bot is addressed; other person is a referenced participant | Do not assume their transcript was supplied or merge their identity with the speaker |
| Bare ping / “在嗎” | LLM interprets shared context: answer a pending request, clarify an ambiguous reference, or choose a personality-appropriate social response when no substantive request exists | Playful annoyance, acknowledgment, reaction, or deliberate silence may fit a purely social ping; a short trigger alone never authorizes ignoring a substantive contextual request |
| Clear name address, e.g. “松果，你怎麼看？” | Proposed explicit-intent subtype; answer if enabled and allowed | Distinct from an incidental third-person name; expose behavior change in migration |
| “松果剛才說…” without address | Observe if authorized; no mandatory response | Only separately enabled spontaneous participation can join |
| Same-user substantive follow-up in active exchange | Normal continuation after a short fragment-coalescing delay | Narrow fallback for proven continuation if decision service fails; otherwise recorded abstention |
| New person joins without addressing bot | Do not inherit previous person's continuation | Evaluate only under separately enabled spontaneous policy |
| Same user says “謝謝”, “晚安”, or corrects recipient | Close exchange; optional lightweight reaction | Do not force a generated answer or renew the exchange |
| Same user replies to another human without @bot | End/suspend implicit continuation for that branch | Do not override explicit human recipient with topic similarity |
| Expired implicit exchange | No automatic continuation | An explicit mention/reply can still retrieve authorized older context |
| Group discussion | Speak only for a grounded, useful contribution with a clear opening | Provider failure stays silent; no automatic fail-open spontaneous response |
| Reaction threshold reached | Re-evaluate relevance using current context before responding | Skip expired/deleted/stale opportunities; record terminal result |
| Permission, feature, or game ownership denial | Enforce boundary | Safe short notice for explicit requests where appropriate; remain silent for passive events |

Routing precedence: explicit bot mention first; explicit reply to bot second; clear name address third; active same-person continuation fourth; spontaneous opportunity last. A direct request cancels competing optional work. Never interpret a question mark or second-person pronoun alone as proof of recipient.

Retain the 120-second continuation window initially. Make it independently configurable only after replay testing; do not tie it to transcript retention. Renew only on a newly answered human turn with confirmed delivery. Clarifications count as delivered engagement; failed/suppressed sends do not.

## 5. Context contract

Discord context is message-count-first, not time-window-first. Every chat turn starts with the last X eligible messages in its authorized channel, alongside explicit reply ancestry and relevant session/memory context. A message hours or days old can remain relevant. Reply chains strengthen the reference relationship; they are not the only way to include earlier discussion. Reading this context does not itself authorize an unsolicited response.

Shared interpretation applies across trigger modes. A trigger establishes why the bot is considering a turn; the eligible conversation establishes what the turn means. Direct mentions, replies, name addresses, continuations, and spontaneous opportunities use the same baseline context assembly and attribution rules. Reaction turns add their reaction snapshot. Different access scopes and participation permissions still apply, but trigger labels must not create arbitrary context blind spots or prescribe a canned answer.

For example, a person can describe a problem over several messages and then send only `@bot`. The prior messages already belong to the shared context; no special bare-ping retrieval path or Discord reply link is required. Resolve the intended request from speaker, sequence, topic, unanswered questions, explicit references, and intervening conversation. This same interpretation supports “那這個呢”, “你覺得呢”, short greetings, and later follow-ups. Do not blindly bind every short turn to the immediately preceding message, which may belong to another person or topic. Clarify only when the available context leaves materially different plausible requests.

Classify response substance and required capabilities after interpreting the shared context. The existing current-text-only `isLowSubstancePing` heuristic must not suppress relevant typing/tool capabilities or force acknowledgment when a short trigger refers to a substantive earlier request. Repeated-ping protection should consider whether the referenced request/context changed; it must not treat a new pending question as a duplicate simply because both trigger messages contain only `@bot`. Preserve normal tool authorization and delivery limits.

### Contextual interpretation and playful personality

Preserve the fun purpose of bare-ping behavior, but move conversational interpretation and response style into the LLM. Do not replace it with mandatory greetings, fixed teasing templates, random silence, or a stronger model without evidence. Improve context assembly, model instructions, and evaluation first.

Application responsibilities remain deterministic: verify access and source identity; assemble authorized context; enforce capability authorization, duplicate protection, activity limits, and delivery freshness. The model interprets whether there is a contextual request, a social attention bid, or an ambiguous reference, then chooses appropriate content and tone. This interpretation uses the shared context for all trigger modes and does not require a separate bare-ping model call.

Instruction contract for the existing response generation step:

- Read the current event together with preceding eligible messages. A standalone mention can invoke an earlier question or multi-message description.
- Address a clear substantive request even if the newest message contains only a tag. Personality may color the answer but must not replace it with an unrelated teasing acknowledgment.
- When there is no substantive request, respond naturally in character. A short “幹嘛，又 ping 我 😂” or “wtf, why ping me?” can be appropriate if consistent with the configured persona and conversational tone. These are examples, not prescribed output.
- Repeated purely social pings may warrant playful annoyance, a reaction, or deliberate silence. Do not infer annoyance solely from repeated identical trigger text when the surrounding request changed.
- If materially different references remain plausible, ask a concise clarification rather than invent an intent or automatically greet.
- Keep deliberate social silence separate from provider failure, policy denial, duplicate suppression, and delivery failure in structured outcomes and diagnostics. Log a bounded outcome code, not hidden reasoning.

Replace current-text-only use of `isLowSubstancePing` and `allowSilentDirect` as conversational intent gates with a contextual response outcome. The implementation must allow personality-driven silence only for genuinely social turns, never as a generic failure fallback. If extending the response schema, use a small validated action/intent field and retain the existing non-silent direct-request error path. Invalid or unavailable interpretation must not be recorded as chosen silence.

Migrate `barePingMode` transparently: preserve existing opt-in preference for playful/social silence as a style permission applied after contextual interpretation. An acknowledgment preference may disallow silence on purely social pings, but must not force a greeting instead of answering an earlier request. Do not silently enable new silence behavior for existing configurations.

| Context source | Purpose | Selection and freshness rule |
| --- | --- | --- |
| Current message and burst | What the speaker is asking now | Always retain current event; coalesce only compatible same-person follow-up fragments |
| Explicit reply ancestry | What “this” refers to | Prefer closest relevant ancestors; preserve authors and addressees; may exceed passive age window within separate bounded retrieval policy |
| Active exchange | Continuity for current engaged speaker | Keep relevant confirmed human/bot turns, scoped to branch and account |
| Last X eligible channel messages | Baseline context for every chat turn, including indirect references and group discussion | Count eligible messages after filtering, regardless of elapsed time; include eligible humans and confirmed bot chat output; preserve order, authors, timestamps, and gap markers |
| Targeted earlier messages | Resolve “why didn't you answer him?” / “what he said earlier” | Bounded same-channel retrieval only for an explicit request needing it; author mention is a search constraint, not a transcript |
| User session | Prior exchanges with current speaker | Preserve user/guild/channel isolation; avoid duplicating events already in reply/channel context |
| Durable member memory | Stable facts/preferences with attribution | Audience checks and memory mode apply; never treat memory as a verbatim transcript or assign another person's facts to current speaker |
| Guild knowledge / summaries | Older shared context | Label summary age and sources; summaries do not establish exact wording or new permissions |
| Images / attachments | Ground visual requests | Load supported authorized current/reply images within limits; state when required visual evidence is unavailable |
| Reaction snapshot | Explain the delayed reaction trigger | Preserve reactors, emoji counts, original target, observation time, and current freshness |

Separate message-count selection from continuation eligibility, retention policy, and request/opportunity expiry. A ten-minute conversation gap must not mean “no previous discussion exists.” Age is metadata for assessing changing facts and conversational openings, not a hard relevance cutoff. Actual deletion, forgetting, and configured retention/access policies still apply. Old statements about temporary situations must be described as historical, not assumed to remain true.

Proposed initial count: X = 40 eligible preceding messages, configurable independently of prompt-token budget. This numeric default is a tuning proposal; count-first selection is the requested design. Fetch backward in bounded pages until X eligible messages are collected or a scan cap/end/error is reached. Ineligible messages do not consume X. Start with a scan cap of 300 raw messages / three pages per normal turn; expose an underfilled result instead of silently claiming a complete history. Reuse cached eligible events but recheck access, edits, and deletions. Threads remain separately scoped. Deduplicate reply-chain/session overlap by message ID so the model sees each event once with all its source relationships.

All X eligible messages are context candidates and should be included verbatim when the prompt budget permits. If they do not fit, retain the current/referenced messages and active branch verbatim, and compact older context with attributed summaries and source IDs. Record which messages were summarized or omitted. Do not let a single long message cause all earlier messages to disappear. Keep exact source retrieval available when a follow-up requires wording or details omitted from the summary. Context size and generation cost remain bounded even when the elapsed time covered is large.

Explicit backward references can expand beyond the baseline X using author, topic, quote, reply ID, or message link as retrieval evidence. Replace the earlier proposed 60-minute cutoff with a bounded same-channel expansion, initially at most 500 additional raw messages / five pages within a request deadline. Search only eligible sources; do not expand on every casual mention of a person. A supplied exact message reference can be resolved directly under its declared access policy even if outside the scanned count. Report scan exhaustion or ambiguity honestly rather than infer the message never existed. These scan limits are pilot proposals, not production defaults. Disabled context channels remain disabled.

Suggested prompt priority under budget pressure: current event > referenced message > active branch > relevant recent channel events > relevant session history > summaries/memory. Identity and source metadata must survive truncation. Omit unrelated persona/lore material before dropping the message being answered. Reserve distinct budgets for decision input and answer input, with enough shared evidence to ground the chosen target.

Every turn gets a context report: requested X, fetched/eligible/verbatim/summarized/omitted counts, selected IDs and source types, oldest/newest timestamps, pages scanned, scan-cap status, budget used, and omission counts by reason. Reasons include out-of-scope, author access, missing member, deleted/forgotten, retention policy, forbidden fetch, provider/fetch error, utility origin, deduplication, relevance during expansion, and budget. Ordinary elapsed time alone is not an omission reason. Record absence separately from retrieval failure or incomplete scanning.

When evidence is absent, the bot should say “I don't have that earlier message in the context available to me—reply to it and I can look,” rather than claim the person never spoke or invent a permission explanation. It must not invent reasons for earlier silence; explanations require actual diagnostic evidence.

### Privacy contract

This plan preserves existing access boundaries, but does not assume today's eligibility implementation is sufficient for expanded historical retrieval or derived information. The full privacy contract — inventory, mandatory guard, model gateway, provenance, and invalidation — is defined in [the privacy gateway plan](chat-context-privacy-gateway-plan-2026-10-19.md). Diagnostics and isolated routing fixes can proceed independently. Expanded retrieval, compaction, and reuse of derived context must pass the source-specific gates below before activation, including shadow calls to external models. The shared context builder will become an adapter to the mandatory gateway.

Minimum contract between the two plans:

| Source/change | Gate required before expanded use | If the gate is unavailable |
| --- | --- | --- |
| Raw human history and reply ancestry | Current author/channel eligibility, deletion/forgetting checks, bounded origin resolution, destination checks, and revalidation before use/delivery | Omit unverifiable sources; report incomplete coverage |
| Prior bot output and session exchanges | Traceable source dependencies sufficient to exclude protected quotations/derived facts after access changes | Exclude unverifiable derived output from the expanded context |
| New summaries/compaction | Eligible inputs plus source dependencies, audience constraints, and invalidation on source/policy change | Use bounded eligible verbatim context; report truncation rather than create an untracked summary |
| Existing summaries, memories, and learned character state | Source-specific evidence that recall obeys current visibility and destination rules; legacy handling from gateway Phase C | Do not enable expanded reuse; exclude unverifiable records on the new path or leave that path disabled |
| Reactions and attachments | Authorized target/source and separately eligible actors; filtered counts and inherited source restrictions | Omit the dependent context, not merely its text label |

Each changed source path needs a documented owner and passing restricted-content tests before release. Remaining gateway migration may proceed separately, but a tracked privacy gap is not a waiver for the expanded path. The reliability release must document excluded sources and coverage limitations instead of claiming full rich-context parity prematurely.

Historical retrieval and passive observation share authorization policy but need different resolution behavior. Passive observation remains cache-only and does not walk Discord history on every ordinary message. An admitted historical-context request may resolve missing same-channel ancestors under a bounded request-wide fetch/depth budget, checking each author, origin, scope, and deletion/forgetting state. The existing observation check's cache-miss rejection and three-hop cap must not be reused as proof that an old source is unauthorized.

Return distinct outcomes for denied access, missing/deleted target, unresolved origin, and exhausted resolution budget. An unresolved dependency cannot be treated as allowed; exclude it when needed to establish eligibility. A permitted message whose separate reference cannot be included must not import the reference's content. Preserve utility/game exclusions and cross-channel boundaries. Tests must show identical eligibility with a warm and cold cache when sources are resolvable, and safe underfill when resolution fails.

### Context parity across the seven interactions

All seven use the same rich base: current event, last X eligible channel messages, authorized relevant session/memory/summary information, necessary participant metadata, and supported source attachments. Privacy and relevance still determine availability; “same base” does not grant every user access to identical private data or require every optional source to be loaded on every turn.

| Interaction | Shared baseline | Relevant addition | What may differ |
| --- | --- | --- | --- |
| Direct bot mention | Full authorized base | Explicit mentions and referenced earlier request | Explicit response intent; no optional contribution-score veto |
| Explicit reply to bot | Full authorized base | Eligible reply ancestry | Strong target evidence; chain supplements channel history |
| Bare ping | Full authorized base | No special retrieval requirement; interpret preceding conversation | Contextual answer versus playful social response |
| Name address | Full authorized base | Resolved name/address evidence | Name matching and configured response permission |
| Implicit follow-up | Full authorized base | Confirmed same-person branch and coalesced fragments | Continuation eligibility, window, and quotas |
| Open group conversation | Full authorized base | Eligible multi-speaker opportunity/burst | Conservative participation decision and spontaneous limits |
| Reactions to a bot response | Full authorized base as of evaluation | Eligible watched message, ancestry, filtered reaction snapshot | Reaction threshold, delay, and relevance/opening assessment |

The current actor determines which private/session sources are eligible; a reaction involving several people must not pool their private sessions. Background jobs use the same eligibility checks but have separately authorized purposes/scopes rather than pretending to be one of these user interactions.

Decision calls may use a compact projection of the same approved evidence. They must retain current target, attribution, and referenced context; when insufficient, expand authorized evidence before deciding rather than inventing missing details. Answer generation receives the richer relevant view. Avoid loading the full answer prompt for every observed message: only assemble it when an authorized opportunity is evaluated; observation alone does not trigger a model call.

Acceptance gates for context parity (the minimum privacy gates above apply before activation; broader enforcement is in the gateway plan):

- All seven adapters invoke the shared context builder, with no separate history implementation determining their prompt independently.
- Given the same actor, destination, sources, and policy version, changing trigger mode alone does not remove baseline eligible context; mode-specific evidence is additive.

## 6. Decision reliability

### Unified decision engine

Introduce a `ConversationDecisionEngine` as the single owner of conversational outcomes across all seven interactions. Reuse/refactor existing recipient classification, contribution validation, scheduler limits, and character modules; do not add another independent veto layer on top. Existing eligibility checks own information access (the privacy gateway plan later replaces them), the decision engine owns whether/what kind of response is appropriate, and the scheduler/delivery layer owns capacity reservation and execution.

Current logic is distributed across `CharacterDecisionService`, `CharacterRuntime`, `AddressingModule`, participation policy, scheduler, and response-to-decision conversion. During migration, enumerate each gate and assign one owner. Character modules may contribute style/context or a typed proposal, but cannot silently overwrite an accepted decision. Execution-time invalidation is recorded as cancellation, not rewritten as an original decision to ignore.

#### Ordered stages and authority

| Stage | Owner / input | Output and rule |
| --- | --- | --- |
| 1. Admissibility | Application policy + eligibility checks | Deny if feature/access/source is invalid; the model cannot override this |
| 2. Address evidence | Application event resolver | Explicit mention, reply target, name address, active branch, group opportunity, reaction evidence; preserve conflicting evidence for interpretation |
| 3. Intent and reference | LLM over approved context, with deterministic facts fixed | Substantive request, social attention, follow-up, closing, correction, discussion, ambiguous reference; identify what is being asked and its sources |
| 4. Participation | Engine policy informed by a validated proposal | Answer, clarify, acknowledge/play, react, reply-and-react, silence; group contributions require a grounded reason to join |
| 5. Grounding and capability validation | Application validators | Referenced IDs/actors must exist in approved context; tools stay authorized; unsupported targets cannot pass |
| 6. Scheduling | Scheduler | Reserve, defer within bounded opportunity lifetime, or cancel; quotas do not pretend to be personality decisions |
| 7. Generation and delivery | Conversation service + delivery recheck | Generate/validate appropriate output, recheck dependencies, send once, commit confirmed delivery |

Admissibility is distinct from judging whether a response is interesting. An explicit contextual question is normally answered or clarified; it does not need to earn a spontaneous contribution score. Purely social interactions may use persona-dependent acknowledgment, teasing, reaction, or permitted silence. Spontaneous contributions retain stricter relevance/opening rules. A single contribution-label whitelist must not reject every acknowledgment or playful response across all modes.

#### Decision contract

Illustrative interface and result categories:

```ts
interface ConversationDecisionEngine {
  evaluate(input: {
    context: PreparedTurnContext; // becomes the gateway's ContextHandle when that plan lands
    trigger: TriggerResolution;
    policy: EffectiveChatPolicy;
    opportunity: OpportunitySnapshot;
    trace: ChatTrace;
  }): Promise<DecisionResult>;
}

type DecisionResult =
  | { status: "ready"; decision: ValidatedDecision }
  | { status: "deferred"; reason: DeferReason; resumeAt: number; expiresAt: number }
  | { status: "denied"; reason: PolicyReason }
  | { status: "failed"; failure: DecisionFailure; recovery: RecoveryAction };

interface ValidatedDecision {
  readonly decisionId: string;
  readonly action: "reply" | "react" | "reply_and_react" | "silent";
  readonly intent: "answer" | "clarify" | "social" | "closing" | "contribute" | "abstain";
  readonly responseToEventId: string;
  readonly referentSourceIds: readonly string[];
  readonly recipientIds: readonly string[];
  readonly reasonCode: DecisionReason;
  readonly contextVersion: string;
  readonly policyVersion: string;
  readonly expiresAt: number;
}
```

The engine constructs validated decisions; a raw model JSON object is only a proposal. Server-supplied opaque source handles are preferable to asking a model to reproduce long Discord IDs. Resolve handles back to IDs locally and validate that evidence belongs to the authorized manifest. Keep response event, discussed message, and intended recipient separate: a bare ping can be answered while referring to several earlier messages by the same person; a user asking about someone else remains the current addressee.

`ready + silent` is a successful intentional abstention, not failure. Deferral has a bounded resumption policy and must not sleep indefinitely. The decision expiry limits when to act, not how old its supporting messages may be. Storing a candidate or retrying a failed decision does not refresh its opportunity or continuation window.

Require small, explicit model outputs: interpretation category, permitted source handles, proposed action, concise contribution/response intent, and reason category. Do not request hidden chain-of-thought. Numeric confidence, if retained, is supporting telemetry rather than calibrated truth; source grounding and explicit recipient evidence take precedence over a high score. Include coverage status so the model distinguishes genuinely absent context from incomplete retrieval.

#### Response policy by interaction

| Interaction | Expected decision behavior |
| --- | --- |
| Direct bot mention / explicit reply | Answer or clarify a substantive contextual request; model uncertainty about the answer is not a reason to silently ignore |
| Bare ping | Interpret the same context: answer an earlier request, clarify a reference, or behave playfully for a purely social ping |
| Name address | Clear address follows explicit-intent policy when enabled; incidental name references do not manufacture direct intent |
| Implicit follow-up | Continue a proven branch; handle closings/corrections naturally; use the narrowly authorized failure fallback when appropriate |
| Open group conversation | Join only with grounded useful/social value and a clear opening; do not infer ownership of another person's facts or plans |
| Reaction follow-up | Evaluate the eligible target and current discussion; a reaction threshold is an opportunity, not an obligation to speak |

Explicit bot mention takes precedence over a human reply target when determining whether the bot was addressed. The reply target still identifies what is being discussed. Interleaving weakens implicit continuation but must not erase authorized context. Recipient corrections close the implicit branch without deleting the underlying transcript.

#### Call budget and latency

Do not require an extra LLM classifier for every direct message. For clear direct intent, the generation call can return validated action/intent metadata alongside its answer; the engine validates it before delivery. Optional participation can use a compact decision call before expensive generation or tools. Both routes produce the same decision contract and trace, without conflating generation success with delivery success.

Purely social silence metadata must be validated; a malformed response cannot be interpreted as chosen silence. Side-effecting tool calls require their existing authorization plus an admitted actionable request before execution. Model-generated claims of intent are not new user authorization. Read-only retrieval may expand context through the same eligibility checks; new evidence requires a versioned reevaluation before action.

Bound decision time, provider attempts, and context expansion. Permit at most one configured decision repair/fallback within the overall turn deadline initially; distinguish that from a separate answer-generation attempt. Use provider health/circuit-breaker state to avoid repeated known-failing calls. Coalesce obsolete opportunities and revalidate when delayed rather than generating an answer to a superseded turn. Prefer server-supplied candidate IDs and simpler structured decisions over full-model repair calls; keep exact ID validation. Do not retry permissions, deterministic invalid configuration, or unavailable source evidence as transient failures.

#### Failure policy and explainability

Deterministic policy denial stays denied. A valid model abstention stays a deliberate outcome. Timeout, malformed output, or invalid evidence is a typed failure with explicit recovery, not a low score. Recovery rules below remain authoritative: direct requests retain a response/error path; only proven same-person continuations may use the bounded grounded fallback; ambiguous/spontaneous/reaction opportunities fail silent with failure diagnostics.

Log the stage, decision ID, input context/policy version, stable reason, provider attempts, evidence validity, recovery, and final action. Keep intermediate proposals separate from the accepted decision and actual delivery. “Explain message” should distinguish “not addressed to bot,” “no useful contribution,” “decision service timed out,” “waiting for quota,” and “response cancelled after source changed.” None are interchangeable `ignore` outcomes.

Replace the undifferentiated failed/null outcome with structured categories: unavailable, timeout, HTTP/rate-limit failure, invalid JSON, schema mismatch, incomplete output, invalid target, invalid evidence ID, invalid boundary, recipient mismatch, valid abstention, and valid participation.

Record each provider attempt separately: provider/model, elapsed time, request identifier when available, safe error code, validation field/reason, and fallback outcome. Do not log credentials, raw prompts, full user content, or hidden reasoning. Schema failures should record field paths and expected constraints, not private response text.

Different failure policy by intent:

- Direct requests: decision helper failure does not veto a reply. If required context is missing, ask for it; generation failure produces a concise error.
- Proven continuation: proposed default `grounded_fallback`, behind a rollout flag. Requires fresh confirmed same-person branch, current eligible source, no competing recipient, no interleaving/closing, valid context, available quota, and unchanged policy. It skips only the broken optional decision step; generation remains grounded and bounded. No additional side-effecting tools are enabled by this fallback.
- Ambiguous continuation, spontaneous, or reaction-driven engagement: abstain when the necessary decision cannot be obtained.

Keep `strict` continuation failure mode available. Fallback must not turn every ordinary channel message into a direct request. Do not “fix” these failures by merely lowering motivation thresholds: the incident had no valid score to compare.

Expose separate provider health and generation health. A working chat model does not prove that the decision/utility endpoint works. Add bounded health checks using synthetic content and the actual decision schema; use cached health status and a cooldown/circuit breaker rather than testing on every message.

#### Decision evaluation suite

- Deterministic gates: access, explicit-recipient precedence, source-handle validity, quota/defer expiry, version changes, duplicate suppression, and fallback eligibility.
- Context-paired cases: identical @bot or “你覺得呢” after an unanswered question, completed exchange, isolated greeting, interleaved discussion, and new pending request.
- Multi-person cases: same nickname, quoted third party, human reply + @bot, changed addressee, reaction participants, and interrupted continuation.
- Time cases: relevant old message in last X, expired speaking opportunity with still-readable history, and delayed reaction evaluation.
- Fault injection: provider timeout/invalid JSON/invented target, partial context, tool-result invalidation, policy change, and delivery failure after a valid decision.
- Human-reviewed replay: correct recipient, substantive request answered, appropriate clarification, enjoyable persona response, welcome spontaneous participation, and appropriate silence. Evaluate semantic behavior rather than exact wording.

Track missed explicit requests, false interruptions, mistaken social classification, clarification rate, decision failure/recovery rates, and latency/cost by interaction. Extend the existing continuation/spontaneous replay into a seven-interaction suite; compare prompt/model variants against the same approved fixtures. Do not optimize for reply rate alone or enable broad production behavior changes based only on mocked decision tests.

## 7. Delivery, concurrency, and Discord rate limits

Retain one channel-aware scheduler and per-user session serialization. Give direct requests precedence over optional batches. Coalesce compatible fragments; invalidate an optional response when a direct request supersedes it, the source is edited/deleted, the branch changes, or access is revoked.

Use source-event IDs and persisted delivery origins to avoid duplicate visible replies. Distinguish generation failure, send failure, delivered-but-state-save-failed, cancellation, and deliberate silence. A failed persistence write after a successful Discord send must not trigger another visible answer.

Add caller/feature, channel ID, message ID, operation type, queue age, and retry count to Discord delivery/edit diagnostics. Preserve Discord's retry delay; do not add uncontrolled application retry loops on top of library retries. Debounce panel edits, skip unchanged payloads, and coalesce updates per target message. Determine the actual PATCH caller before changing control-panel or chat update frequency.

Set budgets for total request time and stale optional opportunity age. Emit a single user-facing progress notice only when it helps an explicit request; do not announce optional background deliberation.

## 8. Diagnostics and settings experience

Add a permission-protected “Explain message” action accepting a message link/ID. Show:

1. Whether the event was observed and which behavior claimed/stopped it.
2. Trigger evidence and effective policy version.
3. Interaction/context eligibility, with safe reasons.
4. Context selection counts and omission reasons.
5. Decision attempts and valid abstention versus failure.
6. Queue, quota, cancellation, and delivery outcome.

Absence from retained traces means “no retained record,” not proof that Discord never delivered the event. Reports respect requester access and never expose hidden-channel content or restricted role/member details to unauthorized users.

Settings should show effective values, inheritance, and dependencies in four groups:

- Response triggers: mentions, replies, name address, continuation, spontaneous, reaction follow-up. Present playful social-ping behavior and optional social silence as personality preferences, not separate context rules.
- Context: direct-request scope, passive observation scope, exact thread selection, eligible-message count X, prompt budget, scan/expansion limits, targeted retrieval, summaries, and memory mode. Show actual elapsed history coverage as information, not an expiry control.
- Timing and activity: continuation window/limits, burst delay, spontaneous decision cadence, text/reaction quotas.
- Health and diagnostics: decision provider, fallback policy, shadow/live state, last failures, and explain-message access.

“Enabled but inactive because …” must be visible. Observation, spontaneous speaking, background scans, and durable memory settings must remain distinguishable. Preserve translations in Traditional Chinese, English, and Japanese. Existing configurations retain their scopes; broader reading or speaking is never silently enabled by migration.

### Structured logging and diagnostic trace design

Goal: given a Discord message ID, explain whether it was received, how it was routed, which context was available or excluded, what decision occurred, and whether a response was delivered. Distinguish observed facts from unknowns. The logger must not become a second store of private conversations.

Keep Pino as the transport. The current `src/infrastructure/logging/logger.ts` provides application/environment fields, four credential-redaction paths, and generic error serialization. Extend it with a typed domain event layer and safe serializers; do not replace it with an unrelated logging stack. Credential redaction alone is not sufficient: arbitrary error objects, provider response bodies, URLs, tool arguments, and nested fields can contain protected content.

#### Correlation and common envelope

Every event uses a versioned schema and stable machine-readable event name; human-readable `msg` text is supplemental. Required fields: `schemaVersion`, `event`, `timestamp`, `level`, `application`, `environment`, `instanceName`, `buildSha`, `processRunId`, `traceId`, `spanId`, `component`, and `operation`. Add `parentSpanId`, `parentTraceId`, `guildId`, `channelId`, `sourceMessageId`, `triggerMode`, `triggerSubtype`, `policyVersion`, `contextVersion`, and `durationMs` where applicable.

- Create the ingress trace before behavior dispatch, so pre-chat suppression is visible. Duplicate Discord deliveries receive distinct ingress traces linked to the same event key; deduplication becomes an explicit outcome.
- Preserve a trace through queueing, context preparation, model attempts, and delivery. Coalesced bursts have their own turn trace with protected links to contributing ingress traces. Reaction follow-ups link the watched delivery and their evaluation trace. Scheduled summaries have job traces and no invented human actor.
- Prefer explicit trace context in service contracts; async-local propagation is convenience, not the sole mechanism across timers, queues, and background jobs.
- Store timestamps in UTC; display local time with an explicit timezone in diagnostics. Use a monotonic clock for durations. Sequence numbers per trace help interpret concurrent events without assuming log arrival order.
- Distinguish event identifiers needed for lookup from model-visible data. IDs are sensitive metadata, not anonymous data; restrict access and retention accordingly. Keep user identity and source-ID lists in the protected trace store, not high-cardinality metric labels.

#### Event catalog

| Event | Key fields and purpose | Normal severity |
| --- | --- | --- |
| `chat.ingress.received` | Event kind, source ID, content/attachment presence flags, reception lag; no content | Info for addressed/evaluated turns; bounded compact records for other events |
| `chat.route.resolved` | Trigger/subtype, evidence category, claiming behavior; no free-text evidence | Info |
| `chat.route.stopped` | Stopping behavior, stage, stable reason, whether explicit intent was recognized | Info for expected exclusion; warn for unexpected routing failure |
| `context.authorization.completed` | Purpose, policy version, counts allowed/denied/unknown by source kind and reason | Info |
| `context.selection.completed` | Requested X, fetched/eligible/verbatim/summarized/omitted counts, scan cap, oldest/newest time, budget usage, coverage status | Info |
| `context.invalidated` | Safe cause code, affected stage, rebuild/cancel action | Info; warn on repeated churn |
| `chat.queue.changed` | Enqueued/coalesced/cancelled/admitted, wait duration, quota reason; bounded counts | Debug transitions; terminal disposition included at info |
| `model.attempt.started` / `completed` | Purpose, provider/model, attempt number, fallback flag, latency, tokens, safe provider request ID | Info |
| `model.attempt.failed` | Failure category, HTTP status, safe provider code, timeout/validation path, retry action | Warn for recoverable failure; terminal failure summarized at error |
| `chat.participation.resolved` | Valid decision/failed/unavailable, reply/react/silence, reason, grounding checks, policy thresholds | Info; provider failure is not a valid silence outcome |
| `tool.execution.completed` | Registered tool name, authorization result, duration, returned source counts; no raw args/results | Info; failure severity follows recoverability |
| `discord.operation.completed` / `rate_limited` | Caller/feature, operation, normalized route, target ID in restricted trace, retry delay, queue age, attempt count | Debug for routine edits; warn for rate-limit episode |
| `chat.delivery.completed` / `failed` | Delivery ID, part count, confirmed message IDs in protected trace, failure category | Info / error |
| `chat.state_commit.completed` / `failed` | Persisted/unsaved-after-delivery, dependency manifest version | Info / error |
| `chat.turn.completed` | Exactly one logical terminal outcome, total duration, final reason, coverage, model-attempt/fallback counts, delivery status | Info for normal outcomes; error for terminal internal failure |
| `diagnostics.pipeline.degraded` | Dropped-event counts, sink/queue condition, recovery status | Warn/error via bounded fallback sink |

Terminal outcomes are explicit: `replied`, `reacted`, `intentional_silence`, `access_denied`, `feature_disabled`, `rate_limited`, `duplicate`, `superseded`, `source_invalidated`, `provider_failed`, `delivery_failed`, and `delivered_state_unsaved`. Unknown outcomes after a crash are `interrupted_unknown`, never reconstructed as deliberate silence. If a multipart delivery partially succeeds, record `partial_delivery` with confirmed parts instead of reporting total failure or replaying the whole answer.

Use reason namespaces such as `route.game_channel`, `privacy.author_ineligible`, `context.scan_cap`, `decision.invalid_target`, `decision.timeout`, `participation.no_contribution`, `delivery.missing_access`, and `state.commit_failed`. Maintain a documented enum/schema; do not use an exception message as a reason code. Preserve the first terminal gate and nested model attempt failures so successful fallback does not erase the original problem.

#### Interface and integration

```ts
// Illustrative API; event types are a discriminated union with allow-listed fields.
interface ChatTraceLogger {
  start(input: TraceStart): ChatTrace;
}
interface ChatTrace {
  readonly traceId: string;
  emit(event: ChatDiagnosticEvent): void;
  child(input: SpanStart): ChatTrace;
  finish(outcome: TerminalOutcome): void;
}
```

`emit` accepts typed, validated fields, not `Record<string, unknown>` or raw Discord/provider objects. `finish` is idempotent within a process; persistence deduplicates terminal records by turn ID. Use try/finally at turn boundaries to record unexpected interruption where possible. A process crash can still prevent a terminal event; reconciliation should mark stale open traces as unknown after restart.

The shared context builder, decision engine, and provider wrappers emit their own events. Trigger adapters only provide source/correlation metadata, reducing missing instrumentation. Wire the dispatcher, scheduler, delivery service, and background workers into the same trace abstraction. Do not rely on every command author remembering a logging checklist.

#### Privacy, storage, and volume

- Default operational events contain no message text, prompts, responses, memory statements, names, role names, image URLs/data, tool payloads, credentials, or hidden reasoning. Safe error serializers allow-list error class/status/code and sanitize stack/message fields; never dump provider bodies. Tests inject nested secrets and content canaries to verify exclusion.
- Protected diagnostic records can hold source IDs, policy dependencies, and per-source omission reasons needed for “Explain message.” Recheck the viewer's permissions at read time; ordinary users receive safe summaries of their own outcomes, not another member's restrictions or hidden-message existence.
- No raw-content diagnostic capture by default. If a future opt-in troubleshooting mode is added, require explicit scope, access, expiry, and deletion handling; it must never capture material the eligibility checks exclude.
- Proposed retention: compact operational logs seven days; protected per-source manifests 24 hours; metadata-only terminal traces seven days. These are new pilot proposals, distinct from existing evaluation-store retention. Bound records/bytes per instance and guild; expose truncation. Forgetting/deletion must remove or unlink applicable diagnostic identifiers and dependencies as policy requires, including exported sinks. Avoid exporting identifying traces to a sink that cannot meet that requirement; use non-identifying aggregate metrics there.
- Retain addressed-turn terminal outcomes, evaluated optional opportunities, and failures without intentional sampling under normal capacity. Keep ordinary passive observations as a short-lived bounded receipt index and aggregate counters; sample verbose successful spans. Never claim complete history after eviction or backpressure.
- Aggregate repeated identical 429s into a rate-limit episode with first/last time, count, caller, target scope, and maximum retry delay. Preserve individual attempts in a bounded protected trace where needed. This prevents warning floods without hiding persistence or impact.
- Diagnostics use bounded asynchronous queues. Saturation drops low-priority detail first and increments explicit loss counters; it must not block Discord handlers indefinitely. Logger failure does not disable authorization: privacy checks remain mandatory even if their telemetry sink is unavailable. Emit health warnings through a minimal safe fallback.

#### Metrics and operational views

Generate low-cardinality metrics by instance, trigger, purpose, provider/model, outcome, and reason class: ingress/evaluated/delivered counts, unexplained/incomplete traces, valid decision rate, fallback rate, empty/underfilled context, omission reasons, queue/response p50/p95 latency, model tokens, delivery errors, 429 episodes, and dropped diagnostic events. Never label metrics by message/user/trace IDs. Report optional decision abstention separately from failure; report delivery success separately from generation success.

Provide an “Explain message” timeline from protected trace records. Example safe output: `received → continuation recognized → 18 eligible context messages → decision timeout → fallback succeeded → delivered`. Another example: `received → direct request → 0 selected messages (scan incomplete) → clarification delivered`. If no receipt survives, state “no retained record”; do not say the bot never received it.

Proposed alerts use minimum sample counts and sustained windows: elevated decision failures, explicit turns lacking terminal outcomes, persistent delivery failures, repeated caller-specific 429s, and diagnostic event loss. Expected privacy denials and deliberate silence should not page operators. Thresholds are calibrated from baseline; no notification integration is added by this planning change.

Logging acceptance tests: trace linkage through timers/bursts/reactions; terminal outcomes on all early returns; timeout vs intentional silence; successful fallback with original failure retained; nested redaction/content exclusion; stale viewer access; partial delivery and unsaved state; duplicate terminal emission; bounded queues/disk retention; 429 aggregation; and crash/restart reconciliation. Architecture tests verify that every context/model boundary emits trace events and no component logs full context objects directly.

## 9. Implementation sequence

| Phase | Deliverables and likely code areas | Exit criteria |
| --- | --- | --- |
| 0: Establish baseline | Verify deployed SHA and effective Pinecone policy/provider config without exporting secrets; correlate screenshot IDs; check each hypothesis below; record the constant inventory below | Each incident hypothesis marked confirmed, ruled out, or needs Phase 1 data; reproducible fixtures with synthetic/redacted content |
| 1: Explain failures | Typed Pino event layer, end-to-end traces, safe serializers, bounded trace storage, dispatcher/scheduler/delivery instrumentation, decision failure taxonomy, context reports, delivery caller tags | Explicit requests have clear terminal traces or recorded interruption/loss; no raw private content in logs |
| 2: Reliable routing and decisions | Unified decision contract/owner, migration of existing scattered gates, shared trigger result, bounded ping-off resolution, mention precedence, model failure/deadline logic, proven-continuation fallback flag | All seven modes have explicit outcomes; direct intent cannot be lost to optional scoring; failures cannot masquerade as intentional silence; invalid decisions cannot authorize spontaneous output |
| 3: Context consistency | Shared count-first builder, shared authorization with bounded historical resolution, centralized constants, source-gated retrieval/compaction, contextual personality instructions | Warm/cold-cache and long-gap cases pass; each activated source passes the minimum privacy contract; unavailable sources are excluded and reported; playful behavior evaluated |
| 4: Settings and delivery | Effective-policy UI, explain-message action, migrations/translations, verified edit throttling and delivery deduplication | Defaults preserve scope, explanations match traces, retries cannot duplicate responses |
| 5: Evaluation and rollout | Deterministic replay, fault injection, real-model synthetic replay, shadow decision comparison, one-channel pilot | Acceptance gates below met before broader activation; rollback tested |

Each phase is a reviewable change with its own regression checks. Do not bundle persona rewrites, unrelated memory redesign, and rate-limit tuning into the first failure-diagnostics change. Phase 1 comes before choosing a different model or increasing token limits. The gateway project remains separately sequenced, but Phase 3 activation depends on the minimum source-specific privacy contract in section 5. Derived-context expansion depends on the relevant Phase C provenance/invalidation work; raw eligible history can ship earlier if its own gates pass. Full gateway completion is not required for unrelated diagnostics or isolated routing fixes.

### Phase 0: code-level incident hypotheses

Each row names the code path that would produce the observed symptom. Verify against the deployed SHA, not just this checkout.

| Symptom | Hypothesis | Code path | Check |
| --- | --- | --- | --- |
| 13:02 turn had zero channel history | Character context dropped the whole segment because the last event was older than the gap | `character-runtime.ts:99` returns `[]` when `now - lastEvent > segmentGapMinutes` (default 10). A 12:41 → 13:02 gap is 21 minutes | Confirm character context is enabled for the channel; replay with the 12:41 timestamp |
| Same | Episode cache had already discarded the events | `conversation-episodes.ts:30` filters `snapshot()` to 15 minutes, hardcoded, ignoring the configured window; persisted episodes use `episodeRetentionMs = 15 min` | Check which snapshot path ran (`chat-conversation-service.ts:765`) |
| Same | The window setting cannot go high enough | `character-settings.ts:32` caps `windowMinutes` at 20 | Note for Phase 3; not the cause if the gap rule fired first |
| `no_valid_decision` at 12:26 and 13:02 | The decision returned `null`: provider error, timeout, invalid JSON, schema mismatch, or invalid grounding IDs all collapse to one reason | `character-decision.ts:116` | Capture the decision provider's raw error class and HTTP status for one reproduction; check whether empty context makes grounding IDs impossible to satisfy |
| Same | Empty context caused invalid output: the model cannot reference a message that is not in context | Interaction of rows 1 and 4 | Replay 13:02 with and without the 12:41 messages |
| Unanswered direct tags with no request-start entry | A higher-priority behavior stopped propagation before chat | `trap-channel-behavior.ts` (priority 200) and `spam-guard-behavior.ts` (150) run before observation (110) and mention (100) | Check their logs and stop decisions for the tag message IDs |
| Same | A pre-start eligibility check or context/setup operation stopped or failed, or the supplied logs are incomplete | `MentionChatBehavior.execute` checks eligibility and resolves context before the request-start log; that log precedes `conversation.run`; ordinary generation exceptions are logged and use the error-reply path | Trace ingress through every pre-start return/await; inspect dispatcher errors and complete logs for the source ID. A generation failure alone does not explain a missing start entry |
| Same | Reply-to-bot without ping was not recognized after cache eviction | Reply target resolution without a persisted origin | Check reply targets of the tag messages |

Separate behavior observation: `isLowSubstancePing` does not currently match “在嗎”. That affects short-ping handling, but does not establish why a direct request has no start log. Likewise, expiry of the episode cache alone does not prove the final context was empty: inspect fetched channel history and the merged selection path as well.

### Phase 0: hardcoded constant inventory

Count-first context (X = 40) and a configurable continuation window would be silently clipped by these values. Phase 3 centralizes them into resolved policy, so one setting controls each.

| Value | Locations | Effect |
| --- | --- | --- |
| 120 s continuation window | `character-decision.ts:62` (`localAddressing` default), `character-runtime.ts:241`, `chat-scheduler.ts:114`, `conversation-episodes.ts:47`, `participation-evaluation.ts:19` | Five copies; changing one leaves the others inconsistent |
| 15 min episode retention | `conversation-episodes.ts:10` (default), `:30` (hardcoded in `snapshot`), `conversation-episode-store.ts:3` | Caps history age regardless of count |
| 10 min segment gap → empty context | `character-runtime.ts:98-99`, `character-settings.ts:33` | Turns a quiet gap into “no history” |
| 20 min max `windowMinutes` | `character-settings.ts:32` | Schema cap blocks long-gap context |
| 48 events per channel | `conversation-episodes.ts:23`, `:27`; `chat-conversation-service.ts:774` | Below X once ineligible events are removed |
| 24 events without character context | `chat-conversation-service.ts:774` | Different cap per path |
| 16 events / 8,000 chars / last 8 + 12 relevant | `conversation-episodes.ts:40-44` | Fallback snapshot path |
| 0.7 confidence floors | `character-decision.ts:120-122` | Not configurable; uncalibrated |
| 15 min activity freshness | `character-runtime.ts:449`, `:473` | Separate staleness rule for character state |

## 10. Acceptance scenarios

| Scenario | Required result |
| --- | --- |
| Same incident: “在嗎” then “沒事那為什麼你不回答他” | Both turns use shared context; acknowledge the first if it is only a presence check; second resolves as continuation; decision failure is identifiable and grounded fallback requires valid branch evidence |
| Several problem-description messages followed by only @bot | Answer the contextual request without requiring a reply link or repeating the question |
| Same question invoked by @bot, name address, explicit reply, or follow-up | Eligible shared evidence and attribution remain consistent; response permission can differ by trigger |
| Short trigger after interleaved conversations | Use speaker/reference/topic evidence; clarify when needed rather than attach blindly to the last message |
| Two standalone pings referring to different pending questions | Interpret each contextual request; do not suppress solely because trigger text matches |
| Isolated @bot with no pending request | Personality-appropriate short response or permitted social silence; no mandatory greeting/template |
| Repeated purely social pings | Natural playful response, reaction, or permitted deliberate silence; activity limits still apply |
| Detailed question followed by @bot under a teasing persona | Answer the question, optionally with light personality; do not substitute “why ping me?” for the answer |
| Decision/generation failure during a social ping | Record failure separately from intentional silence; preserve applicable explicit-request error behavior |
| @bot question replying to a human | Bot mention wins recipient classification; referenced human message remains attributed to its author |
| Another user @mentions bot | Same routing contract regardless of display name; permissions produce explainable outcomes |
| Reply to bot with ping disabled after restart/cache eviction | Persisted origin or bounded resolution identifies direct intent without fetching unrelated passive history |
| Historical reply-linked message after restart/cache eviction | Authorized retrieval resolves same-channel ancestry within the shared budget; warm/cold cache produces the same eligibility when resolvable |
| Eligible ancestry exceeds passive observation's three-hop cap | Historical retrieval uses its declared bounded policy; it neither inherits the passive cap blindly nor bypasses access checks |
| Historical ancestry cannot be resolved within budget | Record unresolved/budget-limited coverage and exclude dependencies requiring verification; do not label uncertainty as confirmed permission denial |
| Expanded context includes a bot quote, legacy summary, or session without verifiable dependencies | Exclude the derived source or keep expansion disabled; release cannot waive the minimum privacy gate |
| Summary provenance/invalidation is not ready | Fall back to bounded eligible verbatim context with a truncation report; no untracked compaction |
| A new user asks “你也會嗎？” without a bot address | No inherited continuation from the previous user |
| Same-person fragmented messages | Coalesce without duplicate replies; preserve attachments and ordering |
| Closing, recipient correction, or intervening human conversation | No accidental continuation renewal |
| Ask at 13:02 about authorized 12:41 message | Bounded explicit retrieval can find it despite expired continuation; if unavailable, say context is unavailable |
| Quiet channel: last relevant message was two days ago | Include it when within last X eligible messages; timestamp alone does not exclude it |
| Dense channel: referenced message falls outside X | Bounded targeted expansion retrieves it or reports an incomplete/ambiguous search |
| Most fetched messages are ineligible | Continue bounded pagination toward X eligible messages; report underfill if scan cap is reached |
| X eligible messages exceed prompt budget | Preserve reference/active branch and attributed summaries; report compaction; exact wording is fetched when needed |
| Old temporary fact: “I'm at the station” | Preserve historical context without claiming the person is still there |
| Tag a person with no usable earlier message | No fabricated quote, transcript, or explanation for their silence |
| Context disabled or thread not selected | No expanded reading through fallback, summary, or targeted lookup |
| Source edited/deleted during delayed participation | Invalidate/re-evaluate; do not send stale generated text |
| Decision timeout, malformed JSON, unknown target, incomplete response | Separate categories; bounded fallback; no uncontrolled retry; spontaneous stays silent |
| Generation succeeds but delivery fails | No continuation renewal or delivered quota consumption |
| Delivery succeeds but persistence fails | Record unsaved delivery; avoid second visible response |
| Reaction watch outlives relevant discussion | Skip stale follow-up and record why |
| Repeated PATCH 429 or unchanged panel payload | Respect backoff, collapse updates, preserve caller attribution; avoid retry storms |

Use unit tests for routing/policy and context selection, integration tests for scheduler/provider/delivery boundaries, and replay tests for actual conversation sequences. Validate with Traditional Chinese examples, nicknames, conflicting display names, multiple speakers, and images. Synthetic decisions alone cannot establish real-model reliability or conversational quality.

For contextual personality evaluation, compare identical short trigger text with different preceding conversations: pending question, completed exchange, unrelated interleaving, isolated ping, repeated social pings, and a newly changed request. Judge whether the underlying request was handled and the tone fits, not whether the output contains a particular joke. Compare the current prompt and revised prompt on the same model before attributing shortcomings to model capability or changing models.

## 11. Metrics, rollout, and rollback

Suggested pilot gates, to be measured rather than assumed:

- 100% pass on deterministic access, recipient, cancellation, and duplicate-delivery regression cases.
- Every sampled direct event has a terminal diagnostic record; zero unexplained direct drops in the pilot sample.
- At least 99% valid decision results on a fixed minimum 200-case synthetic real-model evaluation, reported separately by provider, language, and trigger. Report failures before/after fallback and latency; this is a target, not an observed rate.
- No unauthorized context, explicit-other-recipient interruptions, or duplicate deliveries in the evaluation/pilot; any such issue blocks expansion.
- Human review of continuation and spontaneous results separately: welcome contribution, correct recipient, correct attribution, relevant context, natural length, and appropriate silence.
- Track p50/p95 latency, decision failures, context-empty causes, fallback rate, interruption rate, tokens/cost per delivered reply, and Discord 429 counts by caller. Proposed pilot budgets: p95 first response within 30 seconds for simple direct requests and 35 seconds for continuations including coalescing; report tool/image requests separately. Revisit budgets using measured baseline.

Roll out diagnostics first. Compare new decisions/context selection in shadow without extra visible replies or unauthorized reads. Then enable continuation improvements in one selected channel, followed by targeted retrieval and name-address behavior independently. Keep spontaneous behavior unchanged until its own review passes.

Use independent flags for continuation fallback, targeted retrieval, name-address treatment, and context selection. Rollback disables each behavior independently while preserving diagnostic visibility and delivery deduplication. Migration changes must be reversible without deleting existing memory or session data.

## 12. Proposed defaults and boundaries of this plan

Requested context design: shared interpretation across trigger modes using last X eligible channel messages plus reply ancestry, independent of elapsed-time gaps, with bounded retrieval and transparent compaction. Response substance follows the contextual request, not the length or label of the trigger. Recommended accompanying choices: reliable replies to clear direct intent; grounded fallback only for proven same-person continuation; conservative spontaneous participation; safe administrator explanations for every unexpected silence.

Implemented locally through Phase 3: diagnostics, routing/decision contracts, and opt-in guarded count-first text context. The Phase 3 acceptance document records the current X, scan limits, and work/prompt bounds. These limits still require measured tuning. Remaining source migrations, effective-policy UI, real-model quality evaluation, new production models, and live channel activation remain future work; no live read scope or deployment changed.
