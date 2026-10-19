# Phase 4 delivery reliability checkpoint

Status: implemented and verified locally. Phase 4 remains in progress; no deployment, live Discord test, or settings change was performed.

## Reply retries and confirmed delivery

Every planned reply part now receives a random 24-character nonce and `enforceNonce=true`. The same payload and nonce survive all application retries of that part. Mention, ambient/continuation/group, and reaction adapters forward them on message creation. Editing an existing preview keeps its message ID and omits create-only nonce fields. Different parts and new logical replies receive independent nonces.

The installed Discord API types describe enforced nonce uniqueness over the past few minutes: a matching message by the same author is returned instead of creating another. The local regression simulates an accepted send whose response is lost, then confirms one visible message and one acknowledgment callback after retry. This is evidence for stable retry identity in the application, not live verification of Discord behavior. Nonces are not persisted as a cross-process delivery ledger and do not deduplicate independent turns or arbitrary replays beyond Discord's nonce window.

Transient sends retain at most three application attempts with 500 ms / 1,000 ms delays. HTTP 4xx errors other than 408, HTTP 429, and errors declaring a retry wait stop application retries. No new application retry begins after 60 seconds have elapsed; this is not cancellation or a deadline for an already-dispatched SDK request. SDK-internal rate limits/retries remain SDK-owned. An unacknowledged transport error can still leave acceptance unknown; the diagnostics must not assert that nothing was sent.

Source/context eligibility checks run before every application attempt. Once a send is acknowledged, delivery-proof and origin bookkeeping occur outside the retry loop. A synchronous callback failure or rejected origin write cannot resend that part. Typed `chat.delivery.bookkeeping_failed` events report the safe stage/error category without raw exception text. The owner explanation preserves confirmed delivery and separately warns that affected output may be unavailable as future context. The guarded path still requires verified origins, complete dependencies, and confirmed IDs at reuse time.

Partial delivery now returns only confirmed text for both legacy and guarded modes, so session persistence and extraction callers no longer receive the full unsent reply as delivered. The helper stops the remaining chunks. A best-effort localized notice says only that part of the reply was delivered; it does not ask the user to repeat the entire request. Permission/client errors, declared backoff, and source invalidation do not generate an extra notice request. A notice failure is not retried, counted as a reply part, or included in stored assistant text.

## Shared edit scheduling

The existing per-channel scheduler retains its edit timestamps and declared backoff when the last slot unregisters. Replacing a panel/slot cannot reset the shared budget. Idle state expires after the budget/backoff no longer matters; shutdown drops pending work and clears timers/state. Registering after shutdown yields an inactive slot.

Numeric `retryAfter` milliseconds and API `retry_after` seconds are recognized. Declared waits delay pending edits in that channel, including replacement slots, while other channels retain their independent budgets. Pending writes continue to coalesce to the newest payload; unchanged writes remain budget-free. Scheduler timers handle long waits in bounded timer intervals rather than overflowing the platform timer range.

Music panel writers now pass failures to the scheduler before preserving their existing best-effort refresh behavior. Previously, their inner catches returned success and hid retry metadata from the scheduler. A vote edit with a declared rate-limit wait keeps its message for a later edit instead of immediately deleting/reposting it. Existing unchanged-payload checks and refresh floors remain in place.

This checkpoint hardens callers already using `ChannelEditScheduler`. It does not migrate every UI edit or POST/DELETE route to that scheduler, and it does not replace Discord REST's global rate-limit handling. Admin-panel writes and image-preview streaming still need their own wider scheduling review. No empirical production threshold was retuned.

## Validation and remaining work

Full local suite: **4,657 passed / 7 skipped**. TypeScript typecheck, changed/new-file ESLint, and whitespace checks pass. The existing unrelated repository-wide ESLint failures remain documented in the Phase 3 acceptance record.

New coverage includes lost-response nonce reuse, distinct nonce identities across parts and logical turns, no application retry for permanent HTTP errors or declared rate limits, no extra notice during denied/backoff delivery, acknowledged-send bookkeeping failures without replay or leaked errors, accurate partial text, slot replacement without budget reset, API/SDK retry units, backoff coalescing, independent channels, shutdown, actual panel-to-scheduler propagation, and preserving a rate-limited vote message. Existing chunking, attachments, privacy revocation, reaction scheduling, provider, routing, panel unchanged-payload, and settings regressions also pass.

Phase 4 still needs the broader administrator/self-service explanation access contract and remaining settings/delivery acceptance review, including edit paths outside the shared scheduler. Phase 5 remains responsible for real-provider conversation evaluation, live transport observations, shadow comparison, and controlled channel activation. The universal context gateway and currently excluded source classes remain separate work.
