# Model-consumer authority inventory

Current local state, 2026-10-22, through checkpoint 37. See the [closing audit](chat-context-final-audit-2026-10-22.md) and [checkpoint history](universal-context-migration-progress-2026-10-21.md) for acceptance evidence and release limits. This table supersedes the starting migration-gap inventory.

The machine-readable [consumer inventory](model-consumer-inventory-2026-10-21.json) uses the TypeScript AST/type checker to detect capability references, optional methods and bound callbacks outside concrete transports. It distinguishes model replies from Discord interaction replies. It is a drift detector; enforcement is the runtime registered source/projection/operation boundary and frozen composition facades.

| Active consumer | Authority and dispatch path |
| --- | --- |
| `guarded-chat-turn` | Sole live source assembler. Admits registered current/history/ancestry/session/claim/configuration/asset/tool projections, approves character preparation and final immutable reply requests, then authorizes immutable effects. |
| `chat-conversation-service` | Owns scheduling, deadline, admission, orchestration and final gateway calls. Missing source authority fails; there is no alternate legacy context executor. Attribution/voice repairs derive from approved parents. |
| `character-decision` | Immutable decision-input receipt from the assembler or explicit synthetic replay; one-use exact prompt/schema receipt, current source checks on actual attempts, fixed synthetic diagnostic fixture for health checks. |
| `character-runtime` | Public preparation/postprocessing require approved requests. Private fixed module/callback serializers use admitted source/configuration state and registered utility operations. Configuration-only probes require reviewer/persona authority. Removed public consolidation/extraction compatibility APIs and obsolete window summaries. |
| `conversation-model-gateway` | Closed reply, attribution, overflow, current-message extraction, dropped-session consolidation and scoped-drift projections. Every utility/attribution operation binds exact payload and source; repairs require registered parents. |
| `background-model-gateway` | Registered purpose-specific source batches, owned summary/extraction projection and fresh source/member/job/audience checks before attempts and persistence. |
| `channel-summary-scheduler` | Enqueues extraction through capability checks; executes models through the background gateway, signs immutable fact/relation mutation batches and hands registered source context to character reflection. |
| `configuration-model-gateway` | Registered authored uploads/preferences/persona/evaluation; closed compile/analyze/index/probe projections. Index keys must belong to the actual authored projection. Synthetic probes carry no participant or learned state. |
| `memory-engine` | Raw core construction confined to the mandatory production memory facade. Source-owned retrieval queries, authorized claims before conflict classification/embedding and immutable write batches. Query/claim embeddings and classifiers receive exact payload receipts. Context-free core compatibility is limited to explicit domain tests. |
| `example-exchange-selector`, `persona-lore-selector` | Query projection owned by the conversation lease; eligible authored records and exact-text embedding receipts. Caller history/message overrides cannot append embedding content. |
| `embedding-batch` | Delegates only approved exact text occurrences; bounded individual fallback after failed/malformed batches. It grants no independent source authority. |
| `caching-embeddings-client` | Inside the mandatory embedding facade, purpose/scope-keyed cache and in-flight reuse. Every waiter and actual provider callback retain source validation. |
| `generate-self-image-tool` | Reviewed action/source gateway, current reference descriptor and exact image bytes/prompt bound to a registered operation; bounded final assets. |
| `bootstrap/dependencies` | Constructs raw transports privately, instruments them inside frozen mandatory model/embedding facades, injects only those facades. Configuration support flags are preserved; credentials/inner clients are not exposed. |
| Replay scripts | Explicit synthetic/consented authority and common production gateways. Character replay retains actual generated-reply proof; contextual latency mode uses the real decision service. Inventory/help modes do not dispatch models. |

The root model facade enforces reply plus every utility capability. The embedding facade sits outside result and in-flight caches. Architecture tests restrict issuance, core/transport construction and effect ownership, including aliases/re-exports/dynamic imports/require. Newly added source or consumer classes need reviewed serialization, admission and payload/revocation tests; neither a valid lease nor an inventory entry permits arbitrary appended text.

Known exclusions are intentional: unverifiable legacy learned data, unknown/unreviewed tools and cross-channel learned-data reuse without explicit destination-audience authority. Provider-managed public native search has separate public-web lineage and is not represented as application-controlled per-query fetching. Campaign game-state generation is outside this Discord conversation-context inventory.

No tracked active raw-call gap remains in this inventory. Independent semantic/provider/server/pilot acceptance and unrelated repository-wide lint debt are documented separately; this statement does not claim production deployment or a JavaScript/network sandbox.
