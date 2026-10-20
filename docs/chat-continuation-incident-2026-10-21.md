# Continuation incident — 2026-10-21

The user corrected the bot's immediately preceding answer without another mention or explicit Discord reply. This is an intended implicit follow-up.

## Evidence

Trace `1cd9fd88-05d9-4742-b184-d78cbe8d283c` records continuation admission, 23 selected history messages, then cancellation with `operation_suppressed`, `outcome:suppressed`, and `textDeliveryConfirmed:false`. Total duration was about 10.57 seconds. Cancellation occurred 8.003 seconds after the last context coverage event. No decision or `context.guard.sources` event appears between them. A subsequent Pinecone log reports a 4.737-second message GET wait for a selected history source.

This proves that admission worked and no text delivery was confirmed. The eight-second interval and location before `context.guard.sources` strongly point to the guarded saved-session phase's deadline; the old logs do not explicitly name the cancelled phase. Nearby `control_panel` PATCH 429s are separate routes and are not evidence that those edits directly blocked this chat GET. `buildVersion:unknown` cannot verify a deployed commit.

## Fix

- Filter the latest four saved exchanges already represented on both sides in fresh guarded history before session checks. Previously these redundant exchanges were verified through Discord and discarded only afterwards.
- Prime needed saved-session checks with a fresh history page using the existing guarded transport hook. Author eligibility, forgetting, scope, content hashes, bot provenance, and delivered output checks still run. Older/unreturned sources still require forced individual reads.
- Add content-free `context.guard.work` events with assembly/session/validation phase, completed/deadline/failed status, and duration. Existing eight-second phase deadlines and total work bounds remain intact.

Regression tests cover skipping redundant saved-session reads while retaining the actual conversation in the model request, priming needed sessions, and a stalled session emitting its own deadline event and failing closed. No live settings or server deployment are changed by this checkpoint.

Validation: **4,696 tests passed / 7 skipped**; typecheck, changed-file lint, and whitespace checks passed. The guarded-turn suite was rerun after preserving the original four-exchange selection bound: 18 passed.

## Later incident: delayed correction never evaluated

Trace `b778ca74-8ba0-442e-8c8e-0c734c6eb6f7` on build `310f3c449fd2f1ed91ad888e85746d6781d5eb3c` matched proactive chat but completed dispatch without a decision or chat turn in the supplied excerpt. The screenshot shows a correction about sixteen minutes after the bot response. The code explains this path: local continuation uses a two-minute episode window; a single short message entering spontaneous batching does not schedule evaluation until the batch threshold is met. The excerpt does not prove what happened after logging ended.

The follow-up fix adds a candidate path in enabled `eligible_count` context mode for personal-address wording, including wording inside a sentence such as “我是在修你”. This is a bounded admission hint, not recipient authorization. It works with an empty episode cache. Explicit other recipients and recipient corrections remain excluded, and continuation settings, access checks, scheduler quotas, and evaluation cooldowns still apply. Candidates do not wait for the spontaneous minimum-message threshold.

After guarded context assembly, a successful model decision can resolve an older or cross-participant continuation. It must cite the current message, a supplied bot reply, and that reply's human source, target the current speaker, and pass existing confidence, opening, contribution, and recipient checks. Unguarded context cannot use this override. Missing/private evidence or model failure does not grant a reply; recent-only failure fallback remains unchanged. The model prompt now explicitly explains that elapsed time alone does not erase relevance.

Content-free `chat.admission.buffered` diagnostics distinguish `batch_threshold`, `pause_or_cooldown`, `continuation_candidate`, `submitted`, and `invalidated`, with message count and delay. Scheduler diagnostics continue to report evaluation-budget and queue rejection.

This is not unrestricted evaluation of every message: unrelated short group messages retain batching, and personal-address hints currently cover Chinese, English, and Japanese wording. Ambiguous follow-ups without such wording can still rely on the existing recent-exchange or spontaneous paths. A live model's interpretation still needs pilot verification; deterministic tests validate routing and enforcement with controlled decision proposals.

Checkpoint validation: **4,717 tests passed / 7 skipped**; typecheck, changed-file lint, and whitespace checks passed. Regression coverage includes the screenshot's wording after sixteen minutes, empty recent history, cross-participant corrections, missing evidence, private sources, explicit other recipients, low confidence, model failure, unguarded context, cooldown scheduling, and content-free admission logs.
