# Universal context migration progress

This continues the source-migration track in the contextual participation and privacy gateway plans. Completion of interaction-flow work did not complete this track. No deployment or production configuration change is implied.

## Checkpoint 1: guarded native web search

The guarded conversation runner now honors configured web search when the actual reply transport declares native search support. OpenAI Responses and Gemini declare support; OpenAI-compatible transport does not. Unknown transports fail closed for this capability. Shadow and grounded error recovery keep search disabled. Application/context tools, images and derived private context are not enabled by this change.

Every client-side provider attempt and final delivery retain the registered text lease's authorization checks. Capability configuration changes invalidate prepared turns. Public provider search does not carry Discord credentials and does not authorize private source retrieval. The provider executes native search internally; the application cannot interpose on each internal query or undo data already dispatched. This is the provider-managed public-web trust boundary, not a claim to have migrated application tool continuations or implemented per-query egress authorization.

Source display obeys `includeSources`. Display citations are bounded and sanitized; local, credential-bearing and private Discord channel URLs are excluded. This is citation validation, not a DNS/SSRF defense for arbitrary fetching; this path performs no application URL fetch. Provenance records content-free public-web citation hashes separately from protected Discord dependencies and carries that lineage into reused bot text. Search use without returned citations is recorded too. Original protected dependencies still control revocation and forgetting. Public web lineage does not prove factual accuracy or freshness.

`chat.capabilities.resolved` records configured/effective search, transport support, shadow and grounded recovery without query or conversation text. These events explain enabled-setting/runtime differences.

Validation: 162 focused tests passed, along with typecheck, changed-file lint and whitespace checks. All model/transport tests use synthetic fake responses; no paid model evaluation was run for this change. Commit: `fb618d06`.

## Checkpoint 2: effective operator status

Execution and `/status` now use one capability resolver. Status distinguishes configured settings from capabilities available in the current channel, and explicitly lists guarded sources that remain excluded. The actual transport's declared native search support is supplied by bootstrap, rather than guessed from a model name. Legacy execution also disables unsupported search instead of advertising an unavailable native tool. English, Traditional Chinese and Japanese status-rendering tests exercise the real command. Focused validation: 208 tests, typecheck and changed-file lint passed. Commit: `f71065c9`.

## Checkpoint 3: background source revalidation

Channel summaries and queued personal-memory extraction now enter a registered, immutable, purpose-scoped background context and a model gateway that owns their serialized inputs. The Discord port refreshes channel permissions, source text and source authors. Missing validation support, changed/deleted/forgotten sources, changed configuration and invalid extraction jobs stop processing. Queued legacy jobs without their original source representations are dead-lettered before a model call. OpenAI Responses, OpenAI-compatible and Gemini revalidate before each summary/extraction fallback attempt; outputs are checked again before use. Bounded source validation cancels further transport reads on timeout. Diagnostics record purpose, source count and outcome without raw text.

This closes these background operations' stale-input/retry gap. It does **not** migrate the persisted memory claims' provenance, memory-engine embedding/conflict calls, learned-character consolidation, live legacy extraction or every model consumer. Summary-derived records remain excluded from guarded reply recall until that work is complete.

Validation: 103 focused tests passed; the full suite passed 4,881 tests with 7 skipped and zero failures. New tests include actual provider fallback cancellation and fresh Discord source/member reads. Typecheck, build and changed-file lint passed. Commit: `570b97ca`. No paid model call or Discord send occurred.

## Remaining implementation checkpoints (updated)

Checkpoint 4 inventories the remaining model consumers in [model consumer migration](model-consumer-migration-2026-10-21.md) and its machine-readable artifact. A type-aware architecture test detects new/removed capability consumers, including bound callbacks; gateway/lease imports are restricted to their application owner. This inventories the work and prevents ordinary unreviewed growth. It does not close the remaining legacy/raw consumer gaps.

1. Effective capability/source availability is now surfaced in operator status; expand it as each new source migrates.
2. The first background source boundary and provider-consumer inventory are implemented; migrate the remaining inventoried consumers behind the shared mandatory boundary.
3. Migrate summary and personal-memory producers and records with claim-level evidence, subject/purpose/audience authorization and invalidation. Legacy batch identifiers alone do not establish re-readable source provenance.
4. Migrate memory/relationship recall, learned character/profile context and caches; preserve forgetting and reject unproven legacy records.
5. Migrate images, attachments and application tool results/continuations with source and action checks.
6. Close remaining background/probe/extraction/embedding/image consumers and reconcile compatibility strategies.
7. Reread all plan requirements, run scoped local checks and update the alignment ledger with exact evidence. Human review and production rollout remain external validation.

Excluded sources stay closed until their producer and consumer migrations pass. A new abstraction or passing decision replay alone does not close these items.

## Closing verification for these checkpoints

Checkpoint 4 commit: `901e3f4e`. Final full suite: **4,882 passed, 7 skipped, zero failed**. Typecheck, production TypeScript compilation, changed-file ESLint, migration consistency and whitespace checks passed. The original source inventory and migration requirements were reread; the remaining items above are implementation work, not merely a live-test requirement. No paid provider evaluation, production deployment, setting change or Discord send was performed. The server's unrelated `npm ci` failure still needs npm's preceding error output to diagnose.
