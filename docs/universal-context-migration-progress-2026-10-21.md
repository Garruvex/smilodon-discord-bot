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

## Checkpoint 5: durable claim provenance and guarded recall

SQLite and PostgreSQL memory rows now carry nullable, versioned claim manifests. Proofs bind the complete claim identity, scope and statement; unproven overwrites cannot inherit another statement's proof. Background summary and queued extraction writes use their registered source snapshots, and guarded live chat persists only literal-source-grounded human proposals after successful delivery. Legacy rows are not backfilled with invented authority.

Guarded recall checks purpose, guild/channel, audience, current subject eligibility, original source hashes and deletion/forgetting before local ranking. Selected claims are retained as delivery dependencies. Private memory cannot enter public output merely because its owner requested it. The source authority independently rechecks returned rows, including results from an unexpected memory adapter; unproven aliases/relationships do not ride along. Decisions and generation receive the same admitted facts. Source manifests contain hashes/IDs, not conversation text. The logical read/pass ceilings account for the additional checks, while the existing 20-second source-work and 30-second turn deadlines remain.

Current source admission is conservative across channels: a claim requires verified sources in the turn's authorized channel/audience. Unverified legacy claims, external-audience facts and unproven relationship/canonicalization evidence remain excluded. Guarded writes do not send unproven older claims to a conflict model. Migrating relationship metadata, learned state, assets, tools and the remaining legacy consumers is ongoing.

Validation: **4,894 passed, 7 skipped, zero failed**; typecheck, production compilation and changed-file lint passed. New tests cover durable reload, identity tampering, source edits/deletion/revocation, public/private audiences, unsupported proposals, and actual decision/generation projection. Both backend migrations were generated locally; no live PostgreSQL connection, paid model call or deployment was used.

## Checkpoint 6: image source authorization and lineage

Guarded turns now load supported images through their registered source port after author/scope authorization. Current, reply and history images retain distinct labels and message identities; the configured image limit and a four-image hard ceiling apply. Existing caller-supplied image arrays cannot bypass this path. Model decisions receive only the admitted image counts; generation receives the authorized image data.

Input attachment identities are retained as source dependencies and rechecked on provider attempts, persistence, delivery and later reuse. A bot image requires an output origin bound to the actual confirmed Discord attachment identities; a text-only origin cannot certify an arbitrary image. Confirmed delivery records bind those identities, without persisting pixels or signed URLs in manifests. Source phases are serialized to avoid overlapping validations replacing one another's read scope.

Downloads retain the Discord host allowlist and file-signature checks, reject redirects, and enforce byte limits during streaming. These guarantees concern the trusted Discord attachment identity/metadata and the actual bounded bytes supplied to this turn, not general authenticated URL retrieval. Separate extracted/cached descriptions still require their own source-bearing records before reuse.

Validation: **4,902 passed, 7 skipped, zero failed**; typecheck and changed-file lint passed. Tests cover hidden-source omission, history/reply labeling, stale/replaced images, bot-image origin binding, injected caller image arrays and oversized download cancellation. No paid model call or Discord send occurred. Image generation and application tool continuations are the next migration boundary.

## Checkpoint 7: guarded contextual tools and structured resources

Reviewed dice, eight-ball, memory lookup, public-link reading, birthday lookup and Discord server/event lookup now enter one guarded tool executor. Unknown implementations cannot gain authority by imitating a tool name. Configured allow/deny lists and transport support remain authoritative. Shadow and grounded recovery turns keep tools disabled. Every execution checks the registered source context before and after the operation; transport cancellation also reaches in-flight tools. Memory lookup passes the lease into recall and independently authorizes returned rows.

Birthday and server/event snapshots have bounded, content-free resource manifests. The source authority rechecks snapshots and eligible birthday subjects before continuation/delivery and later bot/session/memory reuse. Birthday profiles expose only their existing public birthday fields and guild timezone, never custom birthday-message text. Server/event sources preserve the existing destination-audience checks; guarded event queries filter the bounded current visible snapshot (ten entries), so an empty result is explicitly not exhaustive. Legacy replies without these manifests do not acquire invented source evidence.

Public-link tools require a URL from admitted conversation text. The fetcher applies source authorization on every redirect, retains DNS/connect-time SSRF defenses and rejects private Discord/CDN sources through this public route. Public result identity is recorded separately from protected Discord dependencies; it does not certify factual accuracy or freshness. X mirrors reject redirects. No raw tool result can add provenance or capabilities.

Validation: full suite **4,913 passed, 7 skipped, zero failed**, followed by **101 focused tests passed**, including the additional service-level tool execution scenario. Typecheck, production compilation and changed-file lint are checked for this checkpoint. Unmigrated functional/music/image tools, learned character context and the remaining independent model consumers are still implementation work, and remain the next checkpoints. No paid model or production operation was performed.

## Checkpoint 8: generated image authorization

Guarded turns now honor supported image generation, including the self-image tool. A configured reference is a separate source resource bound to its asset path, media type, size and content hash. The tool requires a registered context and attempt callback, checks the supplied bytes against that resource, revalidates before each provider retry and before accepting generated images, and passes cancellation through both image transports. Changed references and cancelled turns cannot contribute pending images.

Generated images pass the final conversation/effect decision and per-part delivery guard, with confirmed attachment identities recorded by the existing origin writer. Guarded turns do not dispatch speculative image previews before that decision. This is final-image delivery support; no stream-preview authorization is inferred from an enabled setting. Shadow, grounded recovery and unsupported transports keep generation disabled. Operator status shares the actual transport capability.

Validation: full suite **4,919 passed, 7 skipped, zero failed**, then **97 focused tests passed** including two added service-level final-image scenarios. Provider fallback and source replacement tests use fake HTTP/SDK responses only. No paid image/model generation occurred. Remaining functional tools and independent model consumers continue in subsequent checkpoints.

## Checkpoint 9: source-backed learned character state

Character memory reads now require registered source authorization before relevance scoring. New module records persist claim manifests covering their identity, statement and canonically serialized prompt-affecting metadata. Legacy/unproven module records and metadata-tampered records stay excluded. Dependencies and protected member subjects are rechecked before reuse, model calls and writes. New guarded character records retain their channel audience rather than publishing a learned state to the whole guild.

Decision and generation receive the same admitted character contributions. Existing local style and voice hooks operate over the guarded request; voice repair retains its attempt guard. Mood observation and post-delivery learning produce verified state, while module utility calls recheck before every fallback and before accepting a result. Guarded callback planning authorizes candidate facts and original human quotes, strips unproven alternate source statements and validates before scheduling. Scheduled callback delivery, independent evaluation and other remaining legacy consumers still require their separate migration.

The validation pass ceiling now accommodates tool/character phases (64 passes); physical source-read, phase, total source-work and turn budgets remain unchanged. Module-failure logging uses metadata-only safe failures.

Validation: **4,927 passed, 7 skipped, zero failed**, typecheck, production compilation and changed-file lint. Tests cover durable learned-state reload, canonical JSON ordering, metadata tampering, source revocation and actual decision/reply payloads. No paid provider call or production action was performed.
