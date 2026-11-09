# Phase 2 routing and decision acceptance

Status: implemented and tested locally, 2026-10-19. No deployment, live-provider evaluation, or pilot performed. Phase 3 context retrieval and the privacy gateway remain separate work.

## Behavior by interaction

| Interaction | Admission and response behavior |
| --- | --- |
| Direct bot mention | Explicit request priority. An @bot takes precedence over a human reply target; that target remains discussion context. Answer or clarify without an optional contribution score. Generation failures retain the existing error-reply path. |
| Explicit reply to bot | Cached author or persisted chat origin resolves directly. Otherwise, an eligible requester may resolve exactly one same-guild/channel target, with a 1.5-second wait bound. No recursive routing fetch or channel scan. Late results cannot route the request. Existing source/origin filters still decide which content is usable. |
| Bare ping | A transport label, not a declaration of social intent. The generation call interprets authorized history and may answer an earlier request. Tools/images retain normal authorization. Purely social/closing silence requires explicit validated metadata and the configured personality permission. |
| Name address | The existing explicit-address detector and feature/access gates remain. A clear enabled address gets explicit-request priority and a response/error path. Incidental name references retain optional treatment. Successful/error name-address handling stops lower-priority proactive processing of the same message. |
| Implicit follow-up | Uses the proven account/branch and existing continuation window. A valid model abstention remains intentional silence. Decision failure is a separate result; strict mode stays silent with failure diagnostics. Opt-in recovery is narrowly limited below. |
| Open group conversation | Existing opt-in scope, grounded target/evidence, contribution labels, opening/confidence policy, and scheduler quotas remain. Invalid proposals or unavailable decisions cannot authorize output. Reaction-only outcomes remain distinct from text admission. |
| Reactions to a bot response | Existing eligible watch/participant/channel checks create an opportunity. A validated contextual proposal may reply, react, or abstain. A failed decision does not become intentional silence or authorize an action. |

## Gate ownership after migration

| Gate | Owner | Change |
| --- | --- | --- |
| Feature, author, channel, origin and information-access eligibility | Existing access/social eligibility adapters | Preserved. Neither decision metadata nor fallback grants access. |
| Mention/reply/name/branch evidence and response-event identity | `conversation-trigger`, direct reply resolver, existing branch evidence functions | Shared interaction contract; explicit mention precedence; response event is separate from discussion target. |
| Decision response schema and provider recovery | `CharacterDecisionService` | At most two distinct endpoint attempts, six seconds each within a twelve-second budget; abort propagated to built-in transports; one-model budget prevents nested configured-model fallback for these calls. Source/evidence validation is shared with the engine. |
| Whether to reply/react/abstain, and whether generated action is valid | `ConversationDecisionEngine` | One authority for admission and generation validation. Results carry status, action, intent, stable reason, decision ID, evidence/recipient IDs, context/policy versions and expiry. Final validation also follows character postprocessing. |
| Character style/thought context | `CharacterModuleRegistry` and character modules | Hooks contribute context/style. Legacy hook `allowed` values no longer veto admission; `AddressingModule` no longer duplicates the engine's recipient gate. |
| Queue priority, deferral, quotas and reservations | Existing channel scheduler | Explicit/name-address turns use explicit priority. Queued/deferred/cancelled work remains scheduler telemetry rather than a model personality outcome. |
| Source changes, privacy/policy changes, branch freshness, expiry and confirmed delivery | Existing conversation/delivery gates plus fallback revalidation | Preserved or tightened. Cancellation is recorded as suppression, not rewritten as a decision to ignore. |
| Legacy participation-result view | `participationDecision` | Reads the engine's accepted action/reason when available instead of independently reinterpreting a raw proposal. |

## Intent and compatibility

- The reply schema adds `responseIntent` and `referentSourceIds`. Built-in providers propagate these fields. The parser accepts legacy omissions, but omissions cannot authorize new explicit social silence. Unknown references fail validation; explicit requests retain an error path, and optional failures cannot deliver reactions or write proposed memories.
- `barePingMode: acknowledge` remains the default. `personality` permits social/closing silence after contextual interpretation across explicit interactions. It does not label a short turn social, force a greeting, disable capabilities, or permit silence on provider failure.
- Repeated social pings are suppressed after contextual interpretation. This intentionally permits another interpretation call: an unanswered request followed by another ping must not be discarded as a duplicate social interaction. Existing duplicate source-message protection remains.
- Clear name addresses no longer use the legacy ambient cooldown as a conversational veto. The stored `ambientCooldownSeconds` setting remains readable for compatibility; Phase 4 should retire or relabel this obsolete control. Scheduler capacity and source/access checks still apply.
- Exact source IDs remain in use, with deterministic manifest membership checks. Opaque source handles are a later interface improvement; no claim is made that the privacy gateway or count-first manifest has landed.

## Failure recovery and health

`chat.participation.continuationFailureMode` is a guild-level rollout flag:

- `strict` is the default for existing and new configurations.
- `grounded_fallback` permits a bounded answer/clarification only when decision evaluation failed or is unavailable, the current author matches the engaged account, a confirmed bot reply links to that account's supplied human source, the branch is uninterrupted, there is no closing/correction/other addressee, the source and bot exchange are fresh, context is enabled/eligible, and text quota is available.
- Recovery keeps `status: failed` with `recovery: grounded_reply`; successful delivery does not erase the failed decision attempts. It cannot recover a valid model abstention, policy denial, ambiguous/new-speaker branch, spontaneous opportunity, or reaction opportunity.
- Recovery disables all application tools, web search and image generation. Existing memory/session provenance rules are unchanged. Source/policy/privacy changes, opportunity expiry, or loss of branch proof can still cancel delivery.
- Three endpoint failures open a 30-second circuit cooldown. Valid results reset the endpoint's health. Built-in providers receive cancellation and a single-model budget. A third-party implementation ignoring cancellation may finish later, but its late result cannot become an accepted decision. Provider SDK-internal retry details remain opaque.
- `/diagnostic` separates observed decision health from reply-call completion/failure counters. Owner-only `/diagnostic decision:true` uses synthetic content and the real decision schema, shares in-flight work, and caches the result for 60 seconds. It reads no conversation history. Command deployment is required before the new option appears in Discord.

## Regression evidence and limits

Final local validation: **4,529 tests passed, 7 skipped**, TypeScript typecheck, changed-file ESLint, and whitespace checks passed.

The test suite covers all seven interaction identities; explicit mention plus human reply; cached/persisted/bounded reply resolution; contextual answer versus social silence; repeated social pings followed by a substantive request; tool/image preservation for contextual pings; strict versus grounded recovery; new speakers, interleaving, closing, changed addressee, absent proof, expiry, scope and quota denial; unknown targets/evidence/recipients; post-generation contribution checks; two stalled attempts and aborts; circuit recovery; one-model transport budgets; separate generation health; and owner-only synthetic diagnostics.

Runtime/conversation integration uses real local persistence and the existing scheduler, plus fake providers/transports. Existing privacy invalidation, stale delivery, partial send, functional-result, reaction, shadow and scheduler regression tests remain in the full suite. This is deterministic local evidence, not a measured real-model intent accuracy or production latency result. Phase 5's provider/language replay, shadow comparison and controlled pilot remain required before broader rollout.

Phase 2 does not increase channel-history scope, remove time-based context selection, add daily-summary provenance, change user data permissions, lower spontaneous contribution thresholds, or enable continuation/spontaneous participation by default. Those context/source changes remain Phase 3 and privacy-gateway work. Existing provider limits still govern answer generation; the new twelve-second budget specifically bounds participation decisions.

Rollback can restore `continuationFailureMode: strict` without deleting memory or sessions. Full behavior rollback reverts the Phase 2 commits in reverse order while retaining Phase 1 diagnostics; no rollback operation was performed.
