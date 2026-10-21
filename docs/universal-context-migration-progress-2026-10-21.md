# Universal context migration progress

This continues the source-migration track in the contextual participation and privacy gateway plans. Completion of interaction-flow work did not complete this track. No deployment or production configuration change is implied.

## Checkpoint 1: guarded native web search

The guarded conversation runner now honors configured web search when the actual reply transport declares native search support. OpenAI Responses and Gemini declare support; OpenAI-compatible transport does not. Unknown transports fail closed for this capability. Shadow and grounded error recovery keep search disabled. Application/context tools, images and derived private context are not enabled by this change.

Every client-side provider attempt and final delivery retain the registered text lease's authorization checks. Capability configuration changes invalidate prepared turns. Public provider search does not carry Discord credentials and does not authorize private source retrieval. The provider executes native search internally; the application cannot interpose on each internal query or undo data already dispatched. This is the provider-managed public-web trust boundary, not a claim to have migrated application tool continuations or implemented per-query egress authorization.

Source display obeys `includeSources`. Display citations are bounded and sanitized; local, credential-bearing and private Discord channel URLs are excluded. This is citation validation, not a DNS/SSRF defense for arbitrary fetching; this path performs no application URL fetch. Provenance records content-free public-web citation hashes separately from protected Discord dependencies and carries that lineage into reused bot text. Search use without returned citations is recorded too. Original protected dependencies still control revocation and forgetting. Public web lineage does not prove factual accuracy or freshness.

`chat.capabilities.resolved` records configured/effective search, transport support, shadow and grounded recovery without query or conversation text. These events explain enabled-setting/runtime differences.

Validation: 132 focused tests passed before the final citation-display and prompt changes; final checks are recorded in the checkpoint commit. All model/transport tests use synthetic fake responses; no paid model evaluation was run for this change.

## Remaining implementation checkpoints

1. Surface effective capability/source availability in operator status, not only configured toggles and per-turn diagnostics.
2. Introduce a mandatory context/model boundary for the remaining consumers; inventory raw calls and prevent new bypasses.
3. Migrate summary and personal-memory producers and records with claim-level evidence, subject/purpose/audience authorization and invalidation. Legacy batch identifiers alone do not establish re-readable source provenance.
4. Migrate memory/relationship recall, learned character/profile context and caches; preserve forgetting and reject unproven legacy records.
5. Migrate images, attachments and application tool results/continuations with source and action checks.
6. Close remaining background/probe/extraction/embedding/image consumers and reconcile compatibility strategies.
7. Reread all plan requirements, run scoped local checks and update the alignment ledger with exact evidence. Human review and production rollout remain external validation.

Excluded sources stay closed until their producer and consumer migrations pass. A new abstraction or passing decision replay alone does not close these items.
