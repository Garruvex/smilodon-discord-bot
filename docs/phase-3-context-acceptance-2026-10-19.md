# Phase 3 context consistency acceptance

Status: implemented and verified locally on 2026-10-19. No deployment, live Discord pilot, live provider evaluation, or live PostgreSQL validation was performed. Phase 3 satisfies the plan's exit condition for activated sources; unavailable sources are excluded and reported. The universal model gateway remains a separate project.

Implementation checkpoint: `dcf7a8a9` (`feat(chat): complete guarded text context across conversation modes`). This acceptance record follows that verified checkpoint.

## Shared behavior

All seven interactions enter the same registered context lease through the mention, ambient/optional, and reaction adapters. An interaction can request participation; it cannot grant access to another person's information. Existing scheduler, trigger admission, channel, role, game, privacy, and delivery gates still apply.

| Interaction | Authorized context and behavior |
| --- | --- |
| Direct bot mention | Current text, compatible fragments, reply ancestry, last X eligible channel messages, and verified same-owner session exchanges. Explicit intent retains the decision engine's priority and error handling. |
| Explicit reply to bot, including ping disabled | Same builder; the existing bounded routing resolver identifies intent, then the guard independently resolves content and bot dependencies. |
| Bare ping | Same builder. The model examines earlier substantive requests before choosing an answer, clarification, playful acknowledgment, or allowed social silence. Repeated-ping protection applies after intent interpretation. |
| Name address | Same source policy and contextual instructions, with existing address admission and recipient grounding. |
| Implicit follow-up | Same context after the continuation gate admits the turn. Old messages remain usable evidence; their age does not itself renew continuation permission. |
| Open group conversation | Same source policy, with optional participation scoring, recipient/evidence validation, quotas, and cancellation. Rich context does not force a reply. |
| Reactions to a bot response | The target must be verified bot chat with complete dependencies. Eligible reactor identities/counts are recomputed before applying the threshold. Unreadable targets and actors are excluded; another user's private session is never loaded. |

Short text does not determine response substance. Time gaps are timestamps, not proof that a prior message is irrelevant or that a person never spoke. Missing evidence must not be explained as a confirmed privacy denial. Ambiguous references can produce a clarification. Prompt instructions retain the owner-authored persona and allow playful social responses; deterministic tests establish context availability and decision behavior, not real-model conversational quality.

## Activated source inventory

| Source | Current treatment |
| --- | --- |
| Current human message | Fresh source read, scope/origin/access and persistent-forget checks; actor must match the turn. |
| Channel history | Count eligible sources toward X, default 40; keep chronological order and original attribution. Age, silence, and model topic segmentation do not discard the baseline. |
| Reply ancestry | Independently authorize each same-channel ancestor. Unknown, deleted, cross-channel, utility, and unverifiable derived content supplies no text or dependent author name. |
| Coalesced fragments | Re-resolve source IDs and accept only compatible same-author messages. Cached episode text is not imported. |
| New bot chat | Require complete, scoped provenance, exact delivered-body hash, current actor checks, and recursively valid original sources. Legacy/partial output is excluded. |
| Same-owner session | Require complete provenance, original human source, current source versions, confirmed bot message IDs, and matching delivered text. Guild/channel/owner boundaries remain enforced. |
| Reactions | Independently authorize target and each reactor; retain actor fingerprints and recheck membership. |
| Participant identity | Only fresh eligible message-author metadata and permitted reaction identities. Reply-author names come from selected sources. Mentions do not authorize broader profile recall. |
| Base persona | Owner-authored personality plus static context instructions; no learned character contributions. |

Unavailable in this mode: unverified legacy bot/session/episode text, reply overflow summaries, daily/running summaries, personal or shared memory recall, causal/relationship links, learned character state and drift, lore/example retrieval, user profile/customization/birthday fields, attachments/OCR/images, web/tool context, and image generation. These are excluded before prompt assembly, not supplied as supposedly filtered text. A `context.guard.sources` diagnostic reports unavailable classes. Guarded turns do not run memory extraction or consolidate evicted sessions. Background jobs and legacy provider paths have not all migrated to this guard and must not be represented as covered.

## Bounded retrieval and prompt budgets

`guardedContextLimits` centralizes runtime work bounds. The configured message target and character budget remain distinct.

| Work | Bound |
| --- | --- |
| Baseline history scan | 3 pages of up to 100 raw messages; exclusions do not consume X. Underfill is explicit. |
| Backward-reference expansion | Explicit earlier/previous/above/before references, including supported Chinese/Japanese phrases, permit up to 5 additional pages and 8 ranked older messages. This is bounded lexical/speaker matching, not a complete semantic search. |
| Reply ancestry | 20 hops, 6,000 characters; preserve available grounding anchors in the decision projection. |
| Fragments | Up to 16 candidate IDs plus current message, then at most 16 selected messages / 6,000 characters. |
| Individual text | Up to 4,000 characters per message, then fair truncation against the applicable prompt budget. Excerpts are marked; no unverified summary substitutes for omitted text. |
| Session recall | Last 4 exchanges considered, with source/delivery verification. |
| Dependency closure | 128 messages, recursion depth 20, and existing 48,000-character serialized provenance limit. Oversized/unverifiable closure is excluded. |
| Source work | 1,000 logical source reads, 12 validation passes, 20 seconds cumulative context work, at most 8 seconds per phase; model wait time is separate. Validation reads run in groups of four. |

A direct reply reference can resolve outside the paged window within the ancestry bound. A vague reference beyond the scan remains incomplete; the bot must not invent a transcript. Configured legacy time-window/gap/summary settings do not prune this text builder. Decision messages use an independently bounded projection while retaining the reply grounding anchors.

Deadlines abort further admitted work and suppress delivery. Already-dispatched Discord SDK requests may finish; the implementation does not claim hard transport cancellation. Unavailable history can yield a smaller context; loss of mandatory current evidence or an already-selected source invalidates the turn.

## Proof, invalidation, and delivery lifecycle

The application assembles a whitelisted request and replaces provider-supplied provenance/callbacks/delivery metadata. A runtime-registered lease issues complete text proofs only for this assembly. Proofs contain IDs, scope, author IDs, timestamps, actor fingerprints, and hashes; they contain no source text. Legacy assembly continues to issue only partial manifests.

Fresh validation checks source text, author metadata, timestamp, reply reference, origin, current membership/role policy, and persistent forget cutoffs. Supported OpenAI-compatible, OpenAI Responses, and Gemini transports call the guard before every reply retry; decision fallback and attribution verification/repair have equivalent hooks. Checks also run before reactions and each text-delivery attempt/part. A changed source suppresses remaining output. Already-delivered parts cannot be recalled by this mechanism; partial delivery records only confirmed sent text.

Each confirmed Discord part receives its own output hash. Session state uses the actual delivered prefix and confirmed IDs, and rechecks the lease before storing it. A send followed by a storage failure remains a delivered-but-unsaved outcome rather than permission to send a second answer. Disabled/session-only modes do not mint durable manifests.

Forgetting records the durable cutoff before derived cleanup. Matching origin proofs are cleared, and dependent exchanges across session owners are removed within the same guild. Audience, message-author, and reactor dependencies participate. Unrelated guilds and records are preserved. Primary user history is cleared even when the context-cleanup callback fails; the caller receives a specific failure. Read-time cutoff checks remain authoritative against late writes or incomplete cleanup. This is not a claim of atomic physical erasure across stores, deletion of Discord messages, or discovery of unidentified legacy quotations. Unverified legacy data remains unavailable to this path.

## Diagnostics and verification

Typed content-free events report requested/fetched/examined/eligible/selected counts, selected IDs and timestamp coverage, duplicates, truncation, reply/burst coverage, omitted actors, invalid derived sources, source reads, unavailable classes, and validation status. End-of-history, no progress, scan cap, fetch failure, deadline, ineligible current source, and insufficient eligible reactors remain distinct. Existing trace/scheduler/provider/delivery diagnostics connect these events to outcomes. Prompt bodies, source content, and generated replies are not added to production logs.

Validation: **4,607 tests passed / 7 skipped**, TypeScript typecheck, changed/new-file ESLint, migration portability check, and whitespace checks passed. Repository-wide ESLint reports 2,145 errors across 58 unchanged files; none is in this implementation's changed/new TypeScript files. Tests include all seven modes, unlinked contextual pings, playful social intent, long gaps, exact older anchors, capped targeted scans, warm/cold Discord member caches, source edits/deletions, role/policy changes, persistent forget cutoffs, recursive bot/session verification, invalid proof/output/frame rejection, filtered reaction thresholds, stalled reads, retry/attribution transport guards, partial delivery, and SQLite subject cleanup across owners/guilds including empty sessions. Existing routing, scheduler, provider, settings, and legacy regressions also pass.

SQLite tests use real temporary databases, including prior-schema upgrade/restart coverage. PostgreSQL has corresponding parameterized queries and type/migration checks, but its live query behavior is not established here. Seven environment-dependent skips and real-provider/Discord evaluation remain outside local acceptance.

## Activation and next phase

Existing profiles keep `character.context.retrievalMode=legacy`. To select this implementation, enable character context and choose `retrieval-mode=eligible_count` (settings label: Eligible text); history/role/channel and per-channel context gates must also allow the operation. The new choice is localized in English, Traditional Chinese, and Japanese, with Discord command metadata size verified. No live settings or slash-command registration was changed.

Phase 4 covers effective-policy/explanation UI and remaining delivery/settings work. Phase 5 covers real-model synthetic evaluation, shadow comparison, and controlled channel activation. Before broader activation, measure source exclusion, latency, underfill, decision quality, and natural contextual behavior. Do not treat legacy mode as an equivalent guarded privacy boundary; containment of a privacy issue means disabling the affected feature/read scope. Switching retrieval mode preserves existing data and compatibility but restores that mode's documented behavior and gaps.
