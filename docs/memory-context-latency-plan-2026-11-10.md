# Memory context latency improvement plan

Date: 2026-11-10. Branch: `codex/chat-believability-memory-isolation`.

**First release:** let the simple participation decision run before ordinary memory recall. A group message that the bot ignores or reacts to should never wait for a remembered fact. This change can ship with live source verification and requires no database migration.

## Incident and current behavior

On build `a72e4bad`, the sampled pinecone group turns reached the 30-second optional deadline before logging a simple decision. One memory phase took 29,356 ms. A subsequent message from the same author waited 17 seconds in the queue. The affected sources were 13–19 days old, and individual Discord route waits were about 4.2–4.5 seconds.

- `runGuardedChatTurnAttempt` calls `memory.recall()` before `runtime.prepare()`. Inside `MemoryEngine.recall`, the engine verifies alias evidence, checks candidate claims before ranking, expands relations, may call the embedding provider, and retains selected claims. The caller then admits the returned evidence again. Old sources are cached within a turn. Scattered sources can still require individual reads after the three-page prefetch.
- The uncommitted six-second budget starts **after** `memory.recall()`. It checks elapsed time between some operations. A pending page fetch or source read can consume the remaining turn deadline. The existing unit test advances the clock inside a source read and demonstrates that subsequent candidates are skipped. It does not exercise a blocked request through the chat entry point. The incident's time was most likely spent in the engine's candidate check before ranking (`memory-engine.ts`, `context.memories(candidates, false, …)`), which runs inside `recall()` and outside the budget. Do not ship this patch. Drop it when Phase 1 step 4 lands; that step replaces it with a budget covering the whole enrichment path.
- Recall is not the only work before the decision. Between recall and `runtime.prepare`, the turn also checks a reply-chain summary that may call the model (`dependencies.compact`), loads images, selects lore, verifies persona drift and resolves mentioned participants. The simple decision uses none of these except participants and aliases.
- `prepareSimple` uses authorized recent events, recipient aliases and an optional held thought to decide participation. Once it admits an action, it calls `registry.observe` and `registry.contribute` for both replies and reactions. Enabled modules such as relationships can read stored memory during contribution. The reaction returns to the caller only after that work finishes.
- Complete claim dependencies are in `memories.context_provenance`. A `memory_sources.source_message_id` can be a proposal's source message or the ingest fallback. It does not enumerate a claim's complete proof. Aliases and relations also carry their own proofs. Both SQLite and Postgres need coverage.

## Phase 1 — Decide before recall

Apply the change to guarded optional **message** turns that resolve to the simple contract. Reuse the runtime's contract selection so a per-channel override takes the correct path. That selection uses the runtime's private instance contract, so expose it as a runtime method rather than copying the logic into the turn. Move the reply-chain summary, images, lore, persona drift and example selection after the decision with recall; keep participants before it. Explicit requests, legacy decisions and reaction-snapshot inputs keep their existing ordering and live checks in this release. Preserve the decision prompt, thresholds, shadow behavior, held thoughts and join confirmation.

1. **Separate recipient resolution from general recall.** Query matching alias tokens in the current message across eligible members, including someone outside the recent-speaker window. Prefer identity evidence already authorized for this turn. If a plausible named addressee requires old evidence or the lookup is incomplete, withhold the text option for that ambiguous address. An eligible reaction can still proceed. Keep privacy checks on alias evidence and count alias queries separately. Skip durable alias queries in `session_only` and `disabled`.
2. **Finish ignore, exclusion and reaction paths before reply enrichment.** Keep admission bookkeeping and required observation semantics. Split any observation work that loads reply-only context. A reaction still goes through its existing context and delivery checks. Exercise this path with character memory modules enabled.
3. **Enrich an admitted reply once.** Run ordinary recall, retain admitted claims and relations on the same lease, and collect reply-only character contributions. Reuse the existing request approval step and keep `prepared.request` and `prepared.turn.request` pointing to the approved generation request. Preserve the selected reaction on a reply that includes one.
4. **Bound optional reply enrichment separately.** Keep six seconds as the proposed maximum, shortened when the turn has less time left after reserving time for generation and delivery. Cover the whole enrichment path, including engine recall, embeddings, character-memory reads and final admission. Give work a scoped cancellation signal and stage its evidence until accepted. On expiry, continue with the already-approved context. A late completion must never mutate the active lease, enqueue more Discord reads, or delay the next turn. This backstop can follow the decision reorder when its end-to-end test passes.

**Status (2026-11-10, uncommitted):**
- **Steps 1–3 are built.**
  - `CharacterRuntime.decidesBeforeRecall` picks the path.
  - `MemoryEngine.recallAliases` runs recall's existing name step and nothing else. It only reads evidence for names the message contains.
  - Ignore, exclusion and preview finish without recall. So does an admitted reaction, which also skips `registry.contribute`.
  - An admitted reply then loads memories, relations, images, lore, persona drift and the reply-chain summary.
- **Step 1's stricter rule is not built.** That rule withholds text when a named addressee needs old evidence. Today, incomplete names still reach the decision marked `incomplete`.
- **Step 4 is not built**, so the Phase 0 patch is still in the working tree.
- **Tests:** `tests/chat/simple-participation-runtime.test.ts` covers ignore, reaction, preview, admitted reply order, and the explicit and legacy controls. The named-recipient, delete-before-send and blocked-read cases below are still open.

### First release tests

Use the guarded chat entry point, the real recall engine with a controlled source port, and spies on durable reads and actual Discord fetches. Hold an old memory source unresolved beyond the turn deadline.

| Case | Required outcome |
| --- | --- |
| Ignore, exclusion or shadow preview | Decision or exclusion completes. Ordinary recall, reply-only contributions and old-source fetches attributable to them are all zero. |
| Admitted reaction with relationships enabled | Reaction reaches the delivery boundary while the old source remains blocked. No reply enrichment runs. |
| Named recipient outside the window | A known nickname suppresses a text reply to someone else. Ambiguous or unavailable evidence cannot authorize text. |
| Admitted reply with a valid memory | The generation request receives the claim and its proof. Deleting the source after recall and before send suppresses delivery of the stale reply. |
| Optional enrichment budget | Block a source read, a validation page prefetch, or an embedding inside recall. The turn proceeds within the scoped budget and generation reserve. Resolving the blocked operation later leaves evidence and the next turn intact. Gate the backstop on this test. |
| Explicit and legacy controls | Valid memories, existing ordering and tool access are preserved. |

## Phase 2 — Verify stored claims from durable evidence

Keep `memory.verification=live` as the rollout default. Introduce `at_rest` per guild only after the maximum verification age is agreed and shadow checks pass. A missed edit or deletion can leave evidence usable until its last successful verification expires. The read path must enforce that bound even when the sweeper is stopped.

### Storage and event handling

- In both databases, add `memory_dependencies(memory_id, guild_id, channel_id, message_id)` with a unique dependency key and a reverse index on the Discord identifiers. Add `context_source_invalidations` keyed by the same Discord identifiers, plus nullable `verified_at` tied to the current claim proof. Replace dependency rows and reset freshness atomically when a proof changes. Backfill idempotently from parsed provenance. Existing rows begin unverified. A missing or partial index cannot authorize a claim.
- Capture message deletes, bulk deletes and edits affecting the proven representation, including attachment changes where the proof covers assets. Treat uncertain partial updates conservatively. Make invalidation writes idempotent and bulk writes atomic. Preserve the existing in-process revision signal so a turn cannot deliver in the gap before persistence completes. A persistence failure must disable trust in affected at-rest evidence until reconciled.
- A delete invalidates every proof for that message. For an edit, preserve the distinction between a proof of the old representation and a new proof verified after the edit. An older sweep or concurrent backfill must never overwrite a newer invalidation or stamp a replaced proof as fresh.

### Admission, delivery and recovery

1. At the shared lease boundary, require a valid proof, a complete dependency index, no applicable invalidation and verification within the agreed maximum age. Apply this to every entry point, including self-list and tool reads that bypass `findRecallCandidates`. Preserve channel and audience scope, private ownership, source-author and subject eligibility, forget cutoffs, actor projections, resource checks and asset hashes. Continue live validation for evidence in the history window. Alias and relation proofs stay live until their own dependency coverage exists.
2. Retain accepted historical dependencies on the lease with the original IDs, authors, timestamps, hashes and projections. The current delivery adapter expects each retained ID in its fetched-message snapshot. Extend validation to handle stored evidence explicitly, recheck its validity before model use and visible effects, and propagate its full dependency set into derived provenance. An edit, delete, forget or policy change between recall and delivery must suppress the affected output, including when another process records the invalidation.
3. Treat a missing or expired `verified_at` as ineligible for at-rest use. Explicit requests can fall back to live verification to preserve access to valid memories. Optional replies can omit an unverified claim within their budget. Only successful live verification of the complete current proof advances the timestamp. A background sweep refreshes frequently used proofs before expiry under its own rate budget. Track backlog and errors separately from the age enforced at read time.

**Release tests on both backends:** cover multi-source claims, duplicate and bulk events, edit followed by a new proof, migration retries and concurrent proof replacement. Exercise deletion and cross-process forgetting between recall and send, role opt-out, expired and never-verified rows with the sweeper stopped, failed verification, self-list, and a follow-up derived from an at-rest claim. Compare shadow results with live checks before enabling one guild. Switching back to `live` restores live admission immediately.

## Phase 3 — Optional reply memory lookup

Enable this only after Phase 2 is validated. Limit the initial prompt to the top three to five admitted claims. That reduces prompt size. Candidate checks happen before ranking, so measure their cost separately. If they still dominate, evaluate a bounded candidate-selection change against replay results before changing recall behavior. Lookup can include an embedding call, live verification and an additional generation round trip.

- Offer `lookup_memory` only for an admitted optional reply when tool calling and durable recall are enabled. Enforce the channel policy both when exposing the tool and inside execution. `session_only` and `disabled` must reject durable lookup before repository access. Preserve scope and ownership for both search and list.
- Permit one lookup per optional turn, including retries and concurrent tool calls. Use the remaining turn budget with time reserved for the final response. Apply the same admission, evidence retention and delivery checks as up-front recall, including in guilds using `live` verification.
- Test a successful scoped lookup, a refused second or concurrent call, both blocked channel modes, and a source invalidated after tool execution. Keep existing explicit-request limits. Compare optional replies with replay cases that need prior history before broadening rollout.

## Measurement and rollout

Use existing diagnostic events where possible. Attribute durable recall, character-memory enrichment and recipient resolution separately. Count Discord page and individual-message fetches at the adapter, with cache hits counted separately. The generic `phase:"memory"` label also covers persona configuration. Its presence alone cannot identify ordinary recall.

| Order | Release gate |
| --- | --- |
| 1. Decision reorder | Pass the ignore, react, alias, reply and control cases above. On pinecone compare decision reach, queue wait, p50/p95 latency and 30-second timeouts by action. Ignore and react must have zero ordinary recall and zero historical Discord fetches caused by reply enrichment. |
| 2. Optional enrichment budget | Ship after the blocked-operation test passes. Track deadline skips, late completions, and time left for generation on admitted replies. |
| 3. Durable verification | Deploy schema, backfill and event writes with live reads. Compare shadow and live results, resolve unsafe admissions, then pilot one guild. Track fresh admissions, invalidations, expiries, live fallbacks and old-message fetches. Keep the live switch available. |
| 4. On-demand lookup | Track candidates checked, claims supplied, lookup frequency, embedding and tool latency, reply timeouts and recall quality on replay. Expand only after the pilot preserves relevant recall within the optional deadline. |

The maximum at-rest verification age remains an explicit privacy decision before the pilot. Revisit per-user queue replacement separately if queue delays persist after the decision reorder.
