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

## Checkpoint 10: scheduled callback source closure

Scheduled callbacks now persist a separate manifest binding the event claim, schedule, destination, revision and human source identities. Before a model call they reconstruct a registered context from fresh Discord sources, authorize the memory and schedule, and recheck before every fallback and final send. Unproven legacy schedules, changed sources and tampered schedules never dispatch a model call. Confirmed callback replies retain complete source provenance for later reuse. Existing claim/CAS, quota and uncertain-send protections remain in place.

Bot, session, memory and callback proof checks now share one dependency validator for current sources, actors, assets, structured resources and destination audience. Private source proofs require a private destination; matching the requester alone cannot authorize a public disclosure. Actor/resource lineage survives derived reuse, and manifests reject duplicate actor/resource identities. Tool resource resolution is shared between ordinary turns and callbacks.

Configuration-only evaluation request construction no longer performs participant-memory recall. The remaining evaluation/runtime and configuration consumers still need their explicit-purpose gateway migration; this checkpoint does not certify them merely because their request now omits personal memory.

Validation: **4,933 passed, 7 skipped, zero failed**, typecheck, production compilation and changed-file lint. New tests exercise the real scheduled callback worker with verified, legacy, revoked, tampered and changed-during-generation records, plus a same-requester private-to-public derived-text regression. No paid provider calls or Discord sends occurred.

## Checkpoint 11: scoped memory model processing and embedding caches

Guarded memory query/fact embeddings now carry source revalidation into the concrete OpenAI/Gemini transport, cancellation and purpose/audience/source-version cache partitioning. Cache keys hash text rather than retaining plaintext keys, and both hits and completed requests recheck authority; a revoked in-flight result is evicted. Batches carry the same attempt and cancellation contract.

Canonicalization, candidate corroboration and conflict classification now admit only verified, currently readable claims before ranking or external processing. Candidate status has a distinct classification-only admission path; it does not become a fact in reply recall. Background classification is restricted to claims whose complete sources are present in its authorized batch; unsupported historical/resource dependencies stay excluded. Corroboration persists the merged witness manifest in both repositories; an unguarded merge cannot inherit a complete proof. Conflict retries and supersession recheck authority. Memory warnings use safe metadata rather than raw exception payloads.

Actual transport tests also found and closed missing utility-attempt hooks in Gemini and OpenAI-compatible providers. Character and conflict fallback tests now exercise every transport with fake HTTP/SDK responses and verify that revoked sources are never dispatched a second time.

Validation: **4,949 passed, 7 skipped, zero failed**, typecheck, production compilation and changed-file lint. Tests cover cache partitioning/revocation, transport cancellation, unproven/revoked conflict inputs, changes during classification and merged-witness invalidation. No paid model, embedding or production call occurred. Legacy callers without registered contexts, configuration consumers, graph/alias evidence and remaining functional tools still require migration before mandatory universal-boundary closure.

## Checkpoint 12: graph evidence and participant identities

Relations now persist purpose-bound source manifests and a source channel in both backends. Graph reads authorize each edge, both member endpoints and any supporting ordinary fact before traversing that hop; a hidden intermediate cannot influence later retrieval. Invalid, edited and unproven edges are excluded. Verified causal links work even without an ordinary fact row, and the turn authority independently checks their receipts before sending a metadata-free projection to decision/generation. Matching scoped edges can be refreshed from newly verified evidence; legacy rows receive no fabricated backfill.

Explicitly mentioned eligible people now resolve through the same identity source even when they have no message in the selected history. Ineligible profiles stay omitted, the bot is excluded from human mentioned-user projections, and identity changes participate in final validation. Source diagnostics include relation, identity and image counts/phases.

New PostgreSQL/SQLite migrations add relation scope/manifests and preserve the unique identity across channels. Local migration testing exposed drizzle-kit's malformed SQLite expression-index output; the new normalizer and migration check repair/reject that exact generated form. Background validation has a 60-second aggregate source-work budget and a 256-pass logical ceiling, retaining the eight-second per-check limit, so additional guarded phases do not introduce an unbounded worker.

Validation: **4,961 passed, 7 skipped, zero failed**, typecheck, production compilation, changed-file lint and migration checks. Tests cover every-hop authorization, endpoint revocation, edited/tampered/unproven edges, channel isolation, verified refresh, independent reply projection and mentions without history. No live database, paid provider call or Discord send was used. Alias evidence and remaining functional/configuration/compatibility consumers continue next.

## Checkpoint 13: independently authorized identity aliases

Observed aliases now carry their own purpose-bound evidence. A literal self-introduction binds the human text and stable account identity; current profile labels bind the current authorized profile. Requested labels without either source are excluded. Introduction evidence survives a profile rename while old profile-only labels do not. Legacy names cannot resolve a person unless independently rebuilt from a matching current authorized profile. This rebuild does not admit the unproven fact stored alongside the label.

Both repositories retrieve scoped alias source candidates before authorization. Private aliases require a private destination, subject eligibility is checked independently, and the turn authority verifies receipts again before projecting the same minimal mappings into decisions and replies. Collisions preserve every admitted account; bounded lookups explicitly remain incomplete. Alias receipts contain no parent statement, embedding or ordinary claim proof. Actor/resource budgets apply across all admitted source types.

Validation: full suite **4,975 passed, 7 skipped, zero failed**, followed by **92 service tests** and **15 focused alias tests** including added payload, collision and cap regressions. Typecheck, production compilation, changed-file lint and migration checks passed. No paid provider or production action occurred. Mandatory gateway enforcement, remaining functional/configuration consumers and mutable-boundary hardening remain implementation work; this checkpoint does not certify universal closure.

## Checkpoint 14: immutable leases and registered source adapters

Conversation leases now accept only runtime-registered source ports. Architecture checks restrict registration to the Discord adapter and explicit synthetic replay adapter; only the reviewed tool boundary can attach resource resolution/cancellation. Raw objects and spread copies fail before reading content. A lease snapshots callback bindings, scope, input event and source representations; public message, history, reaction, profile and coverage projections are copied/frozen. Adapter object mutations cannot rewrite already admitted evidence. Actual fresh source/permission changes still invalidate the lease. Background snapshots also retain their original reader bindings.

Validation: full suite **4,981 passed, 7 skipped, zero failed**, typecheck, production compilation and changed-file lint. Regressions cover nested projection mutation, callback replacement, raw-port forgery, edit invalidation and unchanged image/session behavior. Two older fixtures that replaced callbacks after opening a lease now configure them before opening. The remaining gateway/configuration/functional consumers continue next; no production or paid provider action occurred.

## Checkpoint 15: birthday actions and public image search

Reviewed birthday setters and booru search now participate in the guarded executor. Other-member targets must come from admitted identities and remain eligible. Both setters check source authorization immediately before storage; the administrator setter rechecks current administrator roles after its asynchronous reads. Public image search carries cancellation, rejects redirects, bounds query/response/tag sizes, checks safe ratings outside age-restricted channels, and records separate public-result lineage. Changed sources suppress continuation; unknown implementations cannot imitate these tool names to acquire authority.

Validation: full suite **4,985 passed, 7 skipped, zero failed**, followed by **18 focused tests** including a late administrator-role revocation regression. Typecheck, production compilation and changed-file lint passed. All network/storage tests use fakes; no production setting, birthday or paid provider request was changed. Music bindings and remaining configuration/compatibility consumers continue next.

## Checkpoint 16: reviewed music bindings and queue sources

Music tools now wrap reviewed command implementations while retaining their shared slash-command access policy. Tool continuations cannot supply their own owner/NSFW/music privileges; those fields and callback bindings come from the turn authority. Playback tools check registered source authorization before action dispatch. Enqueue additionally carries cancellation/revalidation through connection, search fallback and the final queue mutation, so a permission change during search cannot enqueue afterward.

Queue context is a source resource scoped to the player's actual text channel. It authorizes requesters before projecting track metadata, omits hidden tracks and their totals, and reports a bounded partial queue. Resource manifests revalidate this projection before continuation, final delivery and later derived reuse. Other-channel queue disclosure remains excluded pending explicit cross-channel audience authorization. Guarded enqueue confirmations omit a global queue position, which could expose hidden queue activity.

Validation: full suite **4,996 passed, 7 skipped, zero failed**, typecheck, production compilation, changed-file lint and diff checks. Focused tests exercise reviewed-instance registration, role/source revocation, forged continuation privileges, queue filtering/audience and changes during the real gateway's search/fallback flow. No actual playback, provider call or Discord send occurred. Approved configuration and remaining legacy model consumers still require migration.

## Checkpoint 17: explicit configuration authority and closed processing

Authored configuration now has a separate registered scope (guild persona, persona upload, examples upload or owner-scoped preferences), immutable material, bounded fresh-source checks and purpose/owner cache identity. It grants no authority over learned participant facts. A closed configuration gateway owns compilation, preference analysis and embedding projection; arbitrary appended embedding text fails before dispatch. Uploaded files are rechecked before retry and before accepting derived bundles. Preference analysis detects concurrent preference changes before saving. Current file-backed persona handles track actual persona/example files and configured paths; their consumption by live turns is the next integration checkpoint.

The three supported transports recheck preference-analysis attempts; compilation retries are checked in the transports supporting that capability. Batch embedding fallback retains authorization, including individual completion checks. Configuration/context instances are sealed against projection shadowing. Source issuance imports and the revised consumer inventory are architecture-checked.

Validation: full suite **5,007 passed, 7 skipped, zero failed**, typecheck, production compilation, changed-file lint and diff checks. Tests cover forged/wrong-purpose/cross-owner handles, nested mutation, file replacement, appended text, concurrent preference edits, batch fallback and concrete transport retries with fake HTTP/SDK responses. No paid call or production action occurred. Live configuration consumption and remaining compatibility/runtime consumers remain required before universal closure.

## Checkpoint 18: live configuration and preference consumption

Guarded turns now consume registered persona material, select authorized lore/examples and independently check selection results against that material. Raw caller-supplied persona/lore/example arrays cannot append prompt content; missing persona authority uses the fixed built-in configuration. Lore is also supplied to the participation decision. Query embeddings from these selectors carry the conversation's source checks and scoped cache options. Stored preferences are loaded only for the current owner, used as style controls rather than member facts, and revalidated before continuation/delivery.

Persona/preference fingerprints are separate protected resource dependencies in reply, session, memory and callback provenance. File/path changes invalidate derived reuse; another requester cannot recover another owner's preference-derived answer through a bot quote. Callback reconstruction loads fresh registered configuration sources. Issuance imports remain limited to the application owner and composition; manifests and diagnostics contain fingerprints/counts, not configuration text.

Validation: full suite **5,011 passed, 7 skipped, zero failed**, followed by **12 configuration/callback tests** including the added owner-isolation and callback-invalidation scenarios, plus architecture checks. Typecheck, production compilation, changed-file lint and diff checks passed. No paid call, production setting or Discord send occurred. Remaining work is the mandatory model/operation boundary and compatibility/runtime consumer migration; unused legacy selectors are being audited before removal.

## Checkpoint 19: remove unused pre-engine selectors

The reference audit confirmed that the old guild/user memory selectors had no production imports or composition wiring. Removed both implementations, their three obsolete guild-selector tests, stale code comments and consumer-inventory entries. Active recall still uses the source-checked unified memory engine; no active path or feature was disabled to remove these raw embedding sites.

Validation: **24 architecture/guarded-engine tests passed**, TypeScript typecheck, production compilation, changed-file lint and diff checks. The full-suite test count is expected to decrease by the three removed dead-code tests; that decrease is not a feature regression. Remaining active compatibility/runtime consumers still require the mandatory-boundary migration.

## Checkpoint 20: guarded post-turn processing and scoped drift

The guarded path now preserves dedicated extraction, dropped-session consolidation and configured drift through closed source-owned operations. Extraction receives fresh human text, never an unverified assistant draft; third-party and ungrounded proposals are discarded. Consolidation first verifies original human sources, recorded memory modes and confirmed bot deliveries. It writes scoped source manifests and keeps results private when sharing is disabled. Disabled persistence prevents post-turn model calls. Jobs use the existing mutation coordinator and drain tracking.

New drift is channel-scoped, source-backed and permitted only with sharing enabled. Unproven legacy guild-wide overlays are not promoted. Learning updates preserve a valid snapshot; an explicit reset removes the scope's epoch and invalidates dependent contexts and derived replies. Original human/configuration dependencies remain independently revalidated. Main reply and participation consumers receive only admitted scoped drift. Transport fallbacks for consolidation/drift check authorization inside each actual attempt. Empty-count contexts no longer scan an unnecessary history page.

Validation: full suite **5,018 passed, 7 skipped, zero failed**, followed by **21 post-turn/transport tests** including sharing/persistence-disabled cases. Typecheck, production compilation, changed-file lint and diff checks passed. Tests use real SQLite/file stores and fake model transports; no production processing or paid call occurred. Guarded overflow compaction, mandatory live-call enforcement and remaining runtime/evaluation consumers still require migration.

## Checkpoint 21: source-owned reply overflow compaction

The guarded source engine can gather bounded ancestry beyond the verbatim reply window only when a supported compaction operation is available. Unreadable links stop traversal; independent channel history retains its own authorization. Overflow sources are deduplicated, bounded to 40 messages/12,000 characters, retained as dependencies and available to authorized image/tool references. Raw caller-supplied overflow text is ignored.

The gateway serializes the admitted ancestry with speaker IDs/timestamps, checks authorization on actual provider attempts and caps optional compaction at four seconds/one attempt. Ordinary model failure omits the recap while preserving the selected verbatim context; source changes prevent continuation/delivery. The same authorized recap is available to the participation decision and reply. Unsupported transports do not trigger extra deep-history scanning. Post-turn jobs also avoid opening unused contexts when no supported operation is available.

Validation: full suite **5,026 passed, 7 skipped, zero failed**, followed by **18 overflow/transport tests**, including an additional stalled-model/deep-ancestry regression. Typecheck, production compilation, changed-file lint and diff checks passed. No paid call or production action occurred. The next required work includes ephemeral provenance for session-only continuity, mandatory live enforcement and the remaining runtime/evaluation consumers.

## Checkpoint 22: session-only continuity without durable origins

Session-only deliveries retain bounded, expiring origin manifests in process memory. No human text, assistant body or image bytes are retained in this cache, and no session origin is written to the durable backend. Continuity is rebuilt only from freshly authorized human sources and confirmed bot deliveries bound to the exact original trigger. Missing provenance may be reconstructed from these receipts; altered existing proofs cannot be repaired this way. Restart, expiry, forgetting, audience changes and source edits remove eligibility.

Origin metadata and asset descriptors are pinned alongside visible message versions, preventing a changed trigger/proof from passing merely because message text stayed unchanged. Dependency reads are batched per validation phase. Text-only histories do not trigger an unnecessary image-source refetch; admitted images from verified sessions remain available outside the selected baseline window.

Validation: full suite **5,040 passed, 7 skipped, zero failed**, including actual Discord-adapter round-trip tests with fake message transport. Typecheck, production compilation, changed-file lint and diff checks passed. No paid request or live action occurred. Mandatory live enforcement and remaining runtime/evaluation consumers remain unfinished.

## Checkpoint 23: one live conversation source boundary

Every live Discord conversation now supplies a registered source port, including installations using older retrieval/participation settings. The turn plan always selects the guarded executor. Participation rollout remains separate: invalid contextual configurations still fail closed, and enabling the common boundary does not automatically enable contextual participation. Channel history/read-scope opt-outs remain effective; addressed current messages continue working with history disabled.

Removed the duplicate chat executor and its raw extraction, consolidation, overflow and drift helpers, plus the unused Discord history/reply-chain resolvers. Compatibility input arrays cannot restore those paths. Current source, ancestry, history, sessions, images, aliases, memory, tools, configuration and character contributions use the existing common lease. Source and capability diagnostics remain metadata-only. Guarded history reactions now deduplicate, exclude the triggering event and cap at three; prompt-use metrics reflect the admitted projections.

The migration exposed missing behavior in the guarded executor: live memory writes now use the shared subject mutation coordinator, and each user's turn queue remains reserved through background extraction/consolidation. Visible delivery resolves before background processing, but a following turn cannot overtake it. Canon's combined extraction results feed the same fresh human grounding checks as standalone extraction, avoiding a duplicate personal-extraction call. Member-subject proposals must quote the actual subject.

Test migration review:

| Retired expectation | Current coverage / behavior |
| --- | --- |
| Separate Discord depth/time/history resolvers | Common lease count/depth/character bounds and invalidation tests; production adapter tests cover all seven interactions under older and contextual settings |
| Raw caller overflow or unproven stored sessions/facts become model context | Explicit exclusion assertions; positive source-backed compaction, session and post-turn tests remain |
| Fake tools gain authority from a matching name, or raw optional generation precedes decision | Reviewed tool-instance/gateway tests and real runtime preflight/effect paths |
| Unproven dropped exchanges create global drift/consolidated facts | Guarded post-turn/scoped-drift tests with confirmed source receipts; legacy records remain excluded |
| Scheduler unit fixtures implicitly bypass source authorization | Explicit mocked application-result contract; full production adapter/guard/effect integration remains separate |

Validation: full suite **5,020 passed, 7 skipped, zero failed**. The net test-count reduction is from retired duplicate-pipeline tests, with added mandatory-source rejection, architecture and history-disabled acceptance cases. Typecheck, production compilation, changed-file lint, migration and diff checks passed. No paid call or production action occurred. This closes the live legacy pipeline split; registered model-request serialization and remaining runtime/evaluation/embedding consumers are still required for universal gateway closure.

## Checkpoint 24: registered immutable live model requests

The source-owned live assembler now issues registered request snapshots. The reply gateway rejects raw requests and spread copies even when they carry a valid lease. Nested model-visible data, tool schemas and role-set views are copied/frozen; mutable set storage is not exposed through iteration callbacks. Callback bindings are pinned. Functional execution state is an application-owned getter rather than a caller-writable prompt flag.

Attribution verification builds its context inside the gateway from the approved request. Attribution and live voice repairs derive text-only requests from a registered parent, preserving source/persona checks while disabling tools, search, images and reactions. Character modules no longer receive a reply provider. The gateway checks both source and registered persona before dispatch and after results; actual transport retry callbacks retain these checks. Issuance/derivation imports are architecture restricted. This prevents ordinary consumers from appending data to a valid request after approval; the reviewed source assembler remains the trusted initial projection owner.

Validation: full suite **5,029 passed, 7 skipped, zero failed**, typecheck, production compilation, changed-file lint and diff checks. Added final serialized-payload captures, copied-request rejection, mutation/callback replacement, tool-state, read-only-set and retry revocation tests. No paid call or production action occurred. Configuration-only evaluation, remaining background/runtime utility calls and mandatory embedding/model-operation migration remain required; the universal gateway is not yet declared complete.

## Checkpoint 25: background character reflection inherits batch authority

Summary/extraction reflection receives a registered background context instead of loading a synthetic evaluation chat request. Character memory checks the same source proof, guild/channel, author/subject audience, current eligibility and active dependency records before creating relationship observations. Reflection can only use subjects present in the admitted batch; unproven or other-channel facts cannot become character state. The closed relationship lifecycle does not call a model or import raw persona/member context.

Extraction reflection runs only for successfully completed jobs, after worker subject locks are released. It reopens authority over the original source messages, independent of the completed job's lease. Failed jobs and sources changed after completion do not start reflection. Derived observations retain their source manifests and the original memory audience. Source changes are checked again inside the write boundary.

Validation: full suite **5,036 passed, 7 skipped, zero failed**, typecheck, production compilation, changed-file lint and diff checks. New tests exercise successful handoff, failed jobs, edits after completion, lock ordering, unproven records, wrong-channel sources and revocation. No paid call or production action occurred. Configuration-only evaluation and the remaining registered utility/embedding operation migration continue next.
