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
