# Phase 1 diagnostics acceptance

Status: implemented locally, 2026-10-19. No deployment or live Discord validation performed. This phase explains existing behavior; routing, context selection, and participation policies retain their existing semantics.

## Acceptance evidence

| Requirement | Implementation and regression evidence |
| --- | --- |
| Trace receipt before dispatch | `traceGateway` covers startup gating, control-channel handling, reaction fetches, out-of-scope reactions, and exceptions. Gateway/dispatcher child spans share a trace. `gateway-diagnostics`, `application-readiness`, and `behavior-dispatcher` tests cover these boundaries. |
| Explain direct-chat early exits | `MentionChatBehavior` reports disabled chat, duplicates, game exclusions, access denial, missing provider, and unknown reply origins. `mention-chat-routing` verifies unresolved targets and disabled chat without fetching history. |
| Distinguish failed decisions from silence | Decision attempt categories preserve primary failures and fallback results. Context selection reports eligibility/filter counts. Existing decision/runtime/conversation diagnostics tests cover failure, grounding, suppression, and shadow behavior. |
| Preserve ownership through scheduling | Scheduler IDs, queue/admission/terminal events, opportunity replacement links, reservation outcomes, and submitter trace binding. Scheduler diagnostics and channel-edit tests cover queued execution and caller attribution. |
| Explain provider/tool failures | Bootstrap wraps all configured chat, utility, decision, and raw embedding providers. Optional capabilities and method receivers are preserved. Fallback chains trace attempts/cooldowns/stream retries; tool boundaries distinguish return, rejection, unknown tool, malformed JSON arguments, and timeout. `model-diagnostics`, provider/fallback, summary, and real tool-boundary tests cover these cases. |
| Confirm delivery and identify partial sends | Actual sent message IDs and part counts are retained; lookup accepts source or recorded delivery IDs. Existing delivery/conversation tests distinguish partial delivery and unsaved state. |
| Retain safely and enforce lookup access | Per-instance bounded snapshots, runtime schema stripping, TTL/capacity eviction, current channel/history permissions for viewer and bot, owner-only ephemeral lookup, and source/guild invalidation. Persistence/store/command tests cover restart, malformed/oversized data, write races, stale access, and late callbacks after forgetting. |
| Record interrupted evidence | Prior-process unfinished spans, jobs, and buffered opportunities receive one persisted `chat.trace.interrupted` marker. Finished/current-process traces are unaffected. Reconciliation and persistence tests verify idempotence; no delivery retry is authorized. |
| Account for diagnostic loss | Invalid-event, log-only/unscoped-event, synchronous retention/log exception counters supplement eviction/truncation/write-failure counters. Sink fault tests confirm diagnostics do not change execution. |
| Bound rate-limit noise | At most 100 caller/target buckets plus one overflow bucket per 60-second window; separate proactive waits and response 429s, maximum observed wait, flush on shutdown. Scheduled control-panel slots and common chat sends/reactions/previews carry explicit caller tags. Aggregates omit individual trace IDs, URLs, headers, bodies, and arbitrary route text. Rate-limit tests cover overflow, caller attribution, window flush, and content exclusion. |
| Exclude private payloads | Typed diagnostic schemas strip unknown fields. Production `error`/`err` serializers omit exception messages, stacks, bodies, arbitrary codes, and causes, including direct Error arguments. Chat shadow reasons, filenames, URLs, and signature bytes were removed from affected routine logs. Synthetic sentinel tests inspect output without capturing real prompts or responses. |

## Operational limits

- `BUILD_SHA` or `GIT_SHA` supplies a validated build identifier; otherwise it is explicitly `unknown`. A policy fingerprint identifies effective configured guild chat/features/roles/channels/character settings. It is not proof of current Discord permissions, external persona-file contents, or per-user privacy state.
- Retention is best effort: a hard crash can lose the debounced snapshot tail. Reconciliation can only mark retained evidence; absent records never prove absence of receipt. Incomplete evidence can also result from diagnostic loss or truncation, rather than a crash during execution.
- Log exception counters cover synchronous sink errors. Asynchronous transport failures or downstream log collector drops cannot be measured here. Retention remains independent of stdout log levels; `log-only` counts are expected for calls with no message identity, not automatically losses.
- Standalone background provider operations have independent log traces; channel summaries carry guild/channel attribution, and extraction jobs carry batch attribution. Calls without a real source-message identity are not searchable as an individual Discord message. SDK-internal retries are not separate application attempts.
- Rate-limit caller tags describe instrumented call scopes. Unknown paths remain `unknown`; overflow loses per-target detail. Summaries are emitted within a minute or at shutdown and are log-only. No rate limits, retry policies, or throttling settings were changed.
- A returned tool result can describe a business failure; `completed` means execution returned, not that its action succeeded. `no_text_delivery` likewise does not establish intentional silence or a confirmed reaction.
- Owner-only lookup ships in Phase 1. Administrator/self-service UI, full localization, live alert thresholds, and rollout/pilot work belong to subsequent phases. No privacy-gateway enforcement or richer context is enabled by these diagnostics.

## Deployment verification when rollout is authorized

1. Supply the deployed commit as `BUILD_SHA`, start normally, and register the updated diagnostic command through the existing deployment flow.
2. In an authorized test channel, send a mention, a ping-disabled reply, and a continuation; inspect each with `/diagnostic message:<ID>` and confirm source/delivery IDs refer to the same trace.
3. Verify a denied-access case, unavailable decision provider, queue replacement, partial send, and restart interruption using synthetic fixtures or a controlled test instance. Do not capture real prompts or responses.
4. Verify viewer/bot permission revocation and forgetting remove access to retained metadata. Check retention/loss counters and caller-specific rate-limit summaries before broader rollout.

Local regression validation is recorded in the main plan's checkpoint ledger. Live verification remains pending authorization and deployment.
