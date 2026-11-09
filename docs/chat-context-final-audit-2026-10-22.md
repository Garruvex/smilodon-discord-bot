# Common chat context and model boundary: closing audit

> Current settings and flow: see [one chat flow and one admission gate](chat-single-flow-2026-10-25.md). The rollout settings named below were removed.

Updated after the channel-context policy and snapshot redesign (`e8e1e238`, `9238b912`), against the original trigger/context, privacy gateway and contextual participation plans. The original checkpoint-37 audit has been reconciled with the later user-approved [channel visibility and explicit opt-out policy](channel-context-snapshot-plan-2026-10-22.md). This document describes the current local implementation. Earlier dated checkpoints and provider reports are historical evidence, not deployments or new live measurements.

## Completion and scope

Production follow-up: the supplied `97e540e4` trace passed snapshot checks but
failed before reply generation. A locally reproduced request reapproval defect
affected turns carrying music role sets, including empty sets. The correction
rebuilds immutable role views from their values during generation/repair; new
boundary and direct-delivery regressions cover the formerly omitted production
fields. See the [follow-up evidence](channel-context-snapshot-plan-2026-10-22.md#production-follow-up-request-approval-with-music-roles).
Earlier local completion evidence did not certify this production case.

The next production report, now running `4425dd74`, reaches a completed reply
model call but rejects its result at the application gate without delivery.
The precise historical invalidator was not logged and remains unresolved.
Diagnostic checkpoint 43 adds gate/event reasons and correct suppression
classification. The subsequent [delivery policy revision](chat-delivery-policy-plan-2026-10-22.md)
removes broad guild/style/opportunity vetoes and adds bounded evidence refresh.
It is locally verified; successful delivery on the server is not yet confirmed.

The local source and consumer migration is implemented. All production Discord chat entry points use the registered source engine; all configured chat, utility, dedicated decision, image and embedding capabilities are exposed through mandatory frozen model facades. The production memory engine is also behind a frozen mandatory facade. There is no active context-free chat/model fallback selected by a missing port or legacy retrieval setting.

This scope covers Discord conversation context and the consumers listed in the AST [model inventory](model-consumer-inventory-2026-10-21.json). Campaign game-state generation is a separate subsystem and does not receive these chat source authorities. The architecture checks protect ordinary application boundaries; they are not a sandbox against intentionally malicious new JavaScript, arbitrary networking or direct database tampering.

Production deployment, independent wording/semantic review, a newly authorized paid replay and an exact-server/channel pilot remain external acceptance work. The older 216-case and 21-case provider reports cannot certify this new revision. No production setting was changed and no new paid request or Discord send was made during this completion pass.

## Current flow

```mermaid
flowchart TD
  A[Discord message or reaction] --> B[Fresh interaction and source eligibility]
  B --> C[Registered channel/thread source port]
  C --> D[One filtered snapshot: history, ancestry, burst and dependencies]
  D --> E[Authorized sessions, claims, identity, configuration, assets and character state]
  E --> F{Explicit request or optional participation?}
  F -->|Explicit| H[Application-owned destination and answer obligation]
  F -->|Optional| G[Approved decision projection and registered model operation]
  G --> H
  H --> I[Deterministic participation policy]
  I -->|Silent or emoji| Q[Skip reply-only semantic retrieval and text generation]
  I -->|Reply| R[Semantic examples and lore enrichment]
  R --> J[Immutable approved reply request]
  J --> K[Frozen mandatory model facade]
  K --> L[Provider attempts and reviewed tool continuations]
  L --> M[Current access/privacy checks, fresh forget check and immutable effect permit]
  M -->|Authorized| N[Confirmed text and/or emoji delivery]
  M -->|Source edited, no effects started| D
  N --> O[Session commit and approved memory mutation batches]
  O --> P[Fresh guarded post-turn consolidation and extraction]
```

Discord visibility and enabled channel context define collection scope. Explicit user/role opt-outs exclude literal and derived sources. Interaction roles, including restrictions, control triggering and are not collection consent. All seven interactions use this lifecycle, source policy and effect boundary. A trigger decides whether/how an interaction can proceed; it grants no additional read permission. Rich context means selecting relevant authorized evidence, not loading every source on every turn.

| Interaction | Meaning and participation |
| --- | --- |
| Direct bot mention | Explicit request, application-bound destination. It can refer to earlier authorized messages. |
| Explicit reply to bot | Explicit request with independently authorized ancestry; a reply grants no access to a hidden target. |
| Bare ping | Read available conversation before interpreting the ping. A preceding untagged question can be its referent. Personality may make a genuinely social response playful; social/closing duplicates retain bounded suppression. |
| Name address | Matched addressing enters the common explicit-request path. Ambiguous identity is not authority to guess. |
| Implicit follow-up | Decision sees authorized exchange/reference anchors; policy evaluates validated recipient/contribution evidence. An earlier speaker's exchange does not automatically transfer to another person. |
| Open group conversation | Optional useful contribution or emoji/silence under configured scope, budgets and deterministic policy. No generic filler obligation. |
| Reaction to bot | Verified bot target and eligible reactors; no invented current human speaker. Hidden targets exclude their emoji context; thresholds use collection-eligible actors and at least one actor must have interaction permission. |

History uses eligible counts and bounded evidence selection. Quiet gaps alone do not make a reference irrelevant. Candidate coalescing/expiry, the 30-second turn work deadline, retention and historical relevance are separate concerns. Missing evidence requires uncertainty/clarification, not a claim that someone never spoke or lacked permission.

## Source coverage

| Source | Current guard and evidence |
| --- | --- |
| Current text, burst, history, ancestry and overflow | Registered `GuardedConversationContext`; one-time channel/author/opt-out/forget filtering, immutable source snapshots, gateway-event invalidation, batched fresh forget checks at effects, eligible counts, bounded targeted reads and source-owned compaction. Adapters without snapshot notifications retain full revalidation. `guarded-conversation-context`, `guarded-reply-overflow`, real Discord port/adapter tests. |
| Bot output and saved sessions | Confirmed origins, exact output/asset hashes and complete dependencies; no authority from bot identity alone. Session-only origins are ephemeral and bounded. Source deletion/change/forgetting invalidates reuse. |
| Daily summaries and extraction jobs | Registered `GuardedBackgroundContext` and closed `BackgroundModelGateway`; fresh job/source/member/audience checks on actual attempts and persistence, with approved immutable fact/relationship batches. `background-model-gateway`, channel scheduler and memory provenance tests. |
| Ordinary memories | Candidate authorization before external relevance/classification, literal human grounding, purpose/audience/isolation/subject checks, exact-text embedding receipts and immutable write batches. The production facade rejects context-free core compatibility. |
| Relationships, aliases and identity | Endpoint/support proofs, eligible actors and independently validated observed labels. No hidden intermediate graph nodes or legacy alias promotion. `guarded-memory-relations`, `guarded-observed-aliases`, `guarded-character-memory` tests. |
| Learned character state and callbacks | Source-backed `CharacterMemory`, guarded utility operations, scoped drift epochs and fresh callback evidence. Module-owned records do not enter ordinary memory recall. Global drift APIs and the obsolete window-summary cache were removed. |
| Authored ledger replacements | Settings-authorized explicit text, current persona, destination, revision fingerprint and matching admin source record. Verified parent restrictions survive; legacy text/metadata and embeddings are not promoted. A protected configuration resource invalidates old revisions. `authored-character-configuration` tests include the final generation payload. |
| Persona, lore, examples and preferences | Registered configuration with initial file/owner/fingerprint authorization and closed compile/analyze/index serializers. Live replies pin authored material; style edits affect future turns. Explicit personal-preference removal still withdraws that material. Background jobs and configuration mutations retain revision checks. Configuration-only evaluation cannot import participant histories or learned state. |
| Attachments and reference images | Fresh source/actor checks, pinned asset descriptors, bounded approved Discord downloads, exact image bytes and registered image operations. No unapproved partial image previews. |
| Memory/link/server/birthday/image/music tools | Reviewed implementations and action-specific authorization, bounded guarded results, public-fetch restrictions and source/resource dependencies before provider continuations. Music uses the real command/access boundary. |
| Provider-managed public search | Effective setting and actual transport support are shared with status. Public web lineage is separate from protected Discord sources. Native provider queries are a provider-managed boundary; the application does not claim per-query interception or factual verification. |
| Indexes and caches | Source-owned queries, purpose/scope identity, guard outside result and in-flight caches, every waiter revalidated. Batch failures grant only bounded individual fallback for the original exact texts. |
| Diagnostics and delivery | Metadata-only source/decision/model/effect traces. Gate rejection records approval/source/result phase without prompts or provider-attempt inflation. Explain-message preserves recovery, partial/confirmed delivery and uncertainty. |

Unknown/unverifiable legacy records remain excluded. Cross-channel learned-data reuse remains restricted until an explicit destination-audience authorization contract exists. This is a deliberate privacy boundary, not an implicit promise that any readable server channel becomes global context. Existing retention and feature settings still apply; interaction grants remain separate from explicit collection exclusions.

## Mandatory consumer boundary

`ConversationModelGateway`, `BackgroundModelGateway`, `ConfigurationModelGateway` and the reviewed character/memory/tool serializers own approved projections. Runtime registrations bind scope, purpose, payload and current source/configuration authority. The root model facade rejects raw/copied reply requests, copied utility options, modified payloads, wrong-purpose receipts and replayed operations. Raw credentials, clients and transport internals are not exposed.

The guard remains active inside utility/embedding attempts and provider reply/tool loops, and before result exposure, delivery and persistence. It cannot undo bytes already dispatched to Discord or an external provider. Source invalidation causes suppression/rebuild rather than a prompt telling the model to forget hidden data halfway through.

The three replay tools now use explicit synthetic/consented source premises. Incremental character replay retains its actual preceding reply proofs. Compiled entry points work without development `tsx`: `eval:contextual:built`, `eval:conversation:built` and `eval:character-replay:built`. Inventory/help modes perform no paid calls. A live replay still needs explicit credentials/instance and cost authorization.

Architecture tests restrict source/operation issuance, mutation approval, raw transport/core-engine construction and adapters' effect consumption. They cover static aliases, value/namespace/star re-exports, dynamic imports and require/import-equals. The inventory detects added/removed capability consumers; it is a drift detector, not the enforcement mechanism itself.

## Snapshot regression and operator controls

The production incident on `d549c428` recognized and admitted a direct tag, then
exhausted the 20-second context-work budget through repeated REST/member source
validation before reply generation. The fix keeps the budget and mandatory model
facades, but shares one event-invalidated filtered snapshot. It does not bypass
privacy checks or label internal suppression as a model refusal.

The direct-tag adapter regression delivers after 20 nested model checks with no
new history fetch. Another regression reuses 40 history messages across 80 checks
without member/Discord REST. Membership/role/channel/thread events recheck actual
policy rather than vetoing every active guild turn. Relevant source edits request
one fresh assembly/generation before delivery; source deletions and access/privacy
withdrawal block the affected reply. Persona/style edits and new ordinary messages
do not cancel it. Connection loss still prevents trusting missed events.
Unrelated utility-panel and embed-only updates are ignored. Cross-process forget changes are checked against
persistence at effect boundaries.
SQL forget batches are bounded to one guild/channel and preserve individual
subject, topic, slot and timestamp semantics in SQLite and PostgreSQL.

Use `/settings-memory context-opt-out` or the Memory panel to set excluded roles
and user IDs. The lists default to empty. There is no owner exemption. Reaction
threshold context may include non-triggering members, while triggering still
requires an authorized participant. Daily scans/summaries use the same exclusion
policy, including revalidation when role/user consent changes.

`context.guard.validation.mode` records `snapshot`, `effect` or `full`. Snapshots
avoid full history/member REST during nested checks. Live resource values are
snapshots with current participant authorization; background and authored
mutations retain protected revision checks. Generic/non-notifying sources retain the full validation path.
The event tracker uses one bounded metadata-only listener set per Discord client.
It is conservative: a relevant guild permission/membership change can cancel a turn.

## Closing verification and limits

- Latest delivery-policy suite: **5,184 passed, 7 skipped, zero failed**. Full TypeScript checking, production TypeScript compilation, complete Activity/application build, changed-file ESLint and whitespace checks passed. No schema changes were needed; migration consistency was verified in the earlier snapshot checkpoint.
- The actual adapter-to-effect suite now runs behind the production model and memory facades. Fake HTTP tests capture final serialized requests, retries and revocation behavior. SQLite tests exercise persisted facts, temporal revisions, forgetting and invalidation.
- Earlier package/lock validation: `npm ci --dry-run --ignore-scripts --offline --no-audit --no-fund` passed against the current package/lock state. This verifies the local install plan, not a clean Linux/Alpine native-module build or the user's server. The original server excerpt omitted the preceding npm root error; no different cause is invented here.
- Earlier compiled-entry validation: both contextual and lifecycle inventory commands passed without `tsx` or provider calls; character replay's compiled help entry point passed too.
- Previously measured whole-repository ESLint debt: **2,145 errors in 58 files**, including 1,045 errors in generated Activity output. None of its offending files were changed by checkpoints 29–37 compared with `fbdc85b0`; the lint configuration and Activity sources are unchanged. This is historical repository-wide debt evidence; it was not relabeled as a new successful global lint run. Changed source files pass their lint checks. Unrelated repository-wide lint debt remains explicit; no global lint relaxation or unrelated mass rewrite was used to obtain a green label.
- The seven skipped tests and fake transports do not establish live PostgreSQL, Discord transport or server deployment acceptance. No new paid 216-case run, independent human semantic review or production pilot is claimed.

The original plans and the later channel-snapshot design were reread after the implementation. The closing snapshot review also retained preflight lore in generation and narrowed message invalidation so unrelated utility-panel edits do not cancel replies. That reread led to mandatory utility/embedding/reply dispatch, replay migration, dead-path removal, authored ledger repair, guarded public character preparation and closed transport/diagnostic checks in checkpoints 29–37. The remaining release gates are independent semantic review, server build/deployment evidence and a named-channel pilot with an agreed measured-cost budget. Rollback may change participation policy; it must not restore raw source/model access or promote legacy data.
