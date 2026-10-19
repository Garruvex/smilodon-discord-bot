# Chat context privacy guard and model gateway plan

Status: proposed design, not implemented or deployed. Prepared 2026-10-19. Split out of `chat-system-improvement-plan-2026-10-19.md` so diagnostics and isolated routing fixes can ship independently, while context expansion observes explicit source-specific privacy dependencies.

## 1. Scope and relationship to the chat plan

The chat plan preserves today's access boundaries while improving routing, decisions, and context selection. Preserving scope alone does not establish that existing checks cover historical or derived data. Its section 5 minimum privacy contract gates every expanded source path. This plan replaces scattered checks with one mandatory authorization contract covering every model call: live chat, participation decisions, summaries, memory extraction, tool continuations, repair, embedding, and image generation.

Inventory and synthetic test-harness work can start independently. Migrated runtime paths integrate with the chat plan's Phase 1 trace layer for metadata-only production diagnostics. Verify actual serialized provider payloads through a test-only fake transport using synthetic fixtures and restricted-content sentinels; capture remains inside the test harness, not production logs. Production verification uses event metadata and access-controlled source manifests, never recorded prompts or response bodies. Until enforcement is complete, legacy raw provider calls are tracked gaps, not covered paths.

Release dependency: expanded raw history may activate after its authorization, bounded origin resolution, and revalidation tests pass. Expanded bot/session output, summaries, memory, or character state requires the relevant Phase C provenance and invalidation work, or exclusion of those sources from the new path. Phase C capabilities can be delivered per source alongside Phase B; the whole platform need not finish first. Unverifiable legacy content is not allowed merely to preserve prompt richness. These gates apply to shadow model calls as well as visible replies.

## 2. Complete context inventory and shared privacy contract

All chat response modes follow the same privacy contract across all context sources, including channel history, reply chains, emoji reactions, daily summaries, and recalled memory. This is a target architecture and audit checklist, not a claim that every existing path already implements it. Shared filtering does not mean always loading every source: eligibility is checked first, then relevance and budget determine what is needed.

| Element | Contents / purpose | Required eligibility and privacy treatment |
| --- | --- | --- |
| Current human message and coalesced fragments | Text, speaker, request, attachments | Verify interaction eligibility and permitted use of the author's information; apply the same source-content rules used for history |
| Channel history | Last X eligible human and confirmed bot chat messages | Filter authors, channel/thread scope, origin, deletion/forgetting, and current access before selection; ineligible messages do not consume X |
| Reply chain and quoted/referenced messages | Explicit ancestry, quoted target, author/addressee relationships | A reply or mention grants no new permission to read its target; check each source independently; omit inaccessible source text and dependent details |
| Active episode / burst / pending branch | Short-term conversational state and pending requests | Same source checks as channel history; cached/persisted state must not bypass permission changes |
| Prior user session | Stored human/bot exchanges | Enforce guild/user/channel isolation and current source/audience eligibility; old assistant answers can contain derived personal information and need provenance too |
| Reactions and emoji | Emoji, eligible reactor identities/counts, target relationship | Independently check target-message eligibility and each reactor's eligibility; exclude unreadable target text and its dependent reaction context; recompute counts using permitted reactors only |
| Attachments and images | Images, extracted text, OCR, captions, descriptions, filenames, embeds | Inherit source-message restrictions; model-generated descriptions and cached image/text representations retain those restrictions |
| Link previews / linked content | Preview text, fetched documents/pages, quoted excerpts | Discord/private linked sources require their own access checks; a visible URL is not permission to fetch hidden channel content; public web material remains separately sourced |
| Reply-chain overflow summary | Compaction of ancestors beyond verbatim budget | Summarize eligible inputs only; each retained claim must retain source provenance and audience constraints |
| Channel-window / episode summary | Compacted baseline history | Same checks as original events, at creation and recall; compaction never turns excluded messages into eligible facts |
| Daily summary and historical scans | Background summary/fact extraction from selected channels | Respect explicit background scan scope, per-author eligibility, channel memory mode, and fact audiences; revalidate derived claims before reuse in a different turn/channel |
| Personal/member memory | Preferences, statements, activities, stable facts | Check source author and subject eligibility, record audience, isolation, retention/forgetting, and destination audience; current user being allowed to chat is insufficient |
| Shared/guild/channel knowledge | Facts about members, teams, projects, or the server | Validate provenance and audience per fact; being stored as guild knowledge does not automatically make private/member information public |
| Relationships and causal links | Connections between people/events/memory records | Check both endpoints and supporting evidence; exclude links whose protected endpoint or evidence is unavailable |
| Participant identity and aliases | IDs, names, nicknames, role labels, mentions, resolved recipients | Supply only eligible, necessary metadata; mentioning someone does not authorize profile/memory disclosure; keep minimal routing identifiers separate from model-visible identity |
| Structured profile data | Birthday or other explicitly supplied profile fields | Respect field visibility and intended audience; explicit provision does not imply unrestricted cross-channel disclosure |
| User customization | User-provided style/preferences/instructions | Apply only within its allowed scope; distinguish style from personal facts; do not reveal one user's customization to another |
| Configured persona, lore, examples | Bot identity/style, administrator-supplied lore and example exchanges | Treat authored bot configuration separately from participant data; any real-chat examples or personal facts still require provenance/visibility controls |
| Learned character state | Relationship impressions, callbacks, held thoughts, mood/drift, daily sketches | Derived state inherits evidence restrictions; invalidate/rebuild when protected sources change; never retain hidden facts through a personality overlay |
| Tool results | Memory lookup, server lookup, fetched history, other contextual tool output | Apply the same authorization contract before tool output reaches the model; tool invocation cannot widen context scope implicitly |
| Retrieval indexes and caches | Embeddings, snippets, rankings, summaries, cached prompt fragments | Internal representations inherit restrictions; filter candidates before external model reranking; invalidation must reach caches and indexes, not only primary records |
| Delivery/origin and diagnostic metadata | Confirmed send IDs, routing/decision outcomes, omissions | Use for routing and explanation with restricted visibility; no private content or hidden member details in general user-facing reports |

Uniform authorization has several independent dimensions. Check bot channel access, configured read scope, whether the bot may use that author's/subject's information, source provenance, deletion/forgetting and retention, and the audience of the resulting answer. Being readable by the bot does not automatically mean a fact can be disclosed in the current channel. A reply's public audience must be considered, not only the requesting user's permissions. Unresolvable required access/provenance results in exclusion, not guessed permission.

Shared processing order:

1. Resolve current actor, destination channel/audience, trigger, purpose, and policy version.
2. Retrieve candidate metadata under authorized scopes. Do not send raw unauthorized candidates to a model for relevance filtering, summarization, extraction, or embedding. Apply filtering locally first wherever source eligibility is known.
3. Authorize individual events/facts and dependent identity, attachment, reaction, and relationship information.
4. Deduplicate and select/compact eligible evidence under the shared context budget.
5. Supply the same eligible evidence contract to participation decisions, answer generation, tools, and any summary/memory extraction calls. Smaller decision inputs may omit detail for budget, never bypass privacy.
6. Revalidate at recall and before delivery against current access and source versions. Cancel and rebuild when an in-flight response could depend on newly ineligible evidence; do not rely on asking the model to forget it midway.
7. Persist only what the memory mode and audience allow, retaining provenance and invalidation dependencies.

Use a shared authorization service and context envelope rather than duplicated source-specific role checks. Proposed envelope fields: source kind, source event IDs, author/subject IDs, guild/channel/thread scope, permitted audience, source/policy versions, derivation dependencies, retention class, and eligible/omitted reason. Event text is separate from the metadata needed to authorize it. The same interface should be used by live chat, background summaries, memory extraction/lookup, reaction evaluation, and character-state generation.

**Derived information must remain filterable.** Store summary claims with source IDs, affected subjects, and visibility constraints. For a claim combining multiple protected inputs, eligibility cannot exceed their common permitted audience. When permissions change, invalidate affected claims and regenerate from the remaining eligible sources. A monolithic summary without sufficient provenance must be excluded or rebuilt; merely removing a person's name is not reliable privacy filtering. The same rule applies to old bot answers quoting a person, relational memory, learned character state, and retrieval snippets.

Copying or paraphrasing already known restricted content into another representation does not remove its restrictions. Track known quotations/derivations where possible; do not claim perfect detection of arbitrary human paraphrases. Unknown third-party claims remain attributed claims, not verified member facts or authorization to retrieve that person's hidden information.

For reactions, omit the reaction bundle if its target is unreadable; do not use hidden-message emoji as a substitute for hidden text. For a readable target, count and describe only eligible reactors. If partial filtering changes a trigger threshold, evaluate the threshold after filtering. Model context must not imply knowledge of the excluded people or their reaction totals.

Audit and migration must enumerate all producers and consumers of the inventory above. Existing material without usable provenance should be tagged as legacy and excluded from privacy-sensitive recall until it can be safely validated/rebuilt. Rebuilds use currently eligible sources and memory modes; they must not restore deleted/forgotten material. Rollback must not restore a known privacy bypass.

## 3. Architecture: mandatory context engine and model gateway

Decision: adopt a shared context engine backed by a mandatory authorization guard and model gateway. A standalone `filter(messages)` helper is insufficient because callers can forget it, derived information needs provenance, and private information can reach decision/summary/tool models before final response generation.

Current integration gaps to address: `ChatRequest` accepts independently assembled text/context arrays; character preparation can modify a request after assembly; `generateCharacterData` accepts a raw prompt string; bootstrap injects main/utility providers into several independent consumers. Filtering only `ChatConversationService`'s final `reply` call would not protect earlier decision calls, background summaries, repair calls, extraction, or provider-internal tool loops. Existing eligibility checks remain useful policy inputs, but should not remain independently implemented privacy authorities.

| Design option | Assessment |
| --- | --- |
| Optional shared filter helper | Useful primitive, insufficient enforcement; callers can skip it or append unfiltered content afterward |
| Only a final chat-response guard | Catches some mistakes but is too late for decision, summarization, embedding, extraction, and tool-result exposures |
| Shared context engine + mandatory model gateway + guarded tool continuations | Recommended: one authorization contract, one controlled serialization boundary, separate participation policy |

Proposed components:

1. `ContextSourceRegistry`: enumerates source adapters and their metadata/provenance requirements. Adapters retrieve candidates; they cannot authorize themselves or dispatch model calls.
2. `ContextPolicyGuard`: sole authority for source eligibility, subject/audience restrictions, purpose, policy versions, and derived dependencies. Returns explicit rejection reasons; unknown required evidence fails closed.
3. `ConversationContextEngine`: gathers the last X eligible messages and other relevant sources, deduplicates, ranks, and compacts only authorized data. Produces an opaque context handle and safe coverage report, not a mutable bag callers can append to.
4. `GuardedModelGateway`: owns provider transports and prompt serialization. Resolves/revalidates a context handle for every request/attempt; constructs prompts from approved configuration templates and authorized source data. All model consumers use it.
5. `GuardedToolExecutor`: keeps existing action permissions, but also returns source-tagged results to the engine/gateway. Every tool continuation is reauthorized before another provider call.
6. `ContextInvalidationService`: invalidates handles, derived records, indexes, and in-flight work when source/access/privacy versions change. The delivery guard checks the answer's dependency manifest immediately before sending.

Illustrative TypeScript boundary (design sketch; exact types are implementation work):

```ts
type ModelPurpose =
  | "reply" | "participation" | "summary" | "memory_extraction"
  | "memory_classification" | "character_update" | "embedding"
  | "reranking" | "repair" | "image_generation";

// Handle creation and registration are private to the engine implementation.
// Runtime registry validation is required; TypeScript branding alone is insufficient.
interface ContextHandle { readonly id: string }

interface ContextScope {
  readonly guildId: string;
  readonly channelId: string;
  readonly actorId: string | null; // null for authorized background jobs
  readonly destinationAudienceId: string;
  readonly purpose: ModelPurpose;
}

interface ConversationContextEngine {
  prepare(input: TurnContextInput): Promise<PreparedContext>;
  extend(handle: ContextHandle, input: SourceReferenceQuery): Promise<PreparedContext>;
  derive(handle: ContextHandle, purpose: ModelPurpose): Promise<PreparedContext>;
}

interface PreparedContext {
  readonly handle: ContextHandle;
  readonly coverage: SafeContextCoverage;
}

interface ContextPolicyGuard {
  authorize(scope: ContextScope, sources: readonly SourceDescriptor[]): Promise<AuthorizationReport>;
  revalidate(handle: ContextHandle): Promise<ContextValidity>;
}

interface GuardedModelGateway {
  invoke(handle: ContextHandle, operation: RegisteredModelOperation): Promise<GuardedModelResult>;
}
```

Operation definitions contain approved prompt templates/schema and non-content controls, not arbitrary user-bearing prompt strings. Source queries specify bounded references/scope; callers cannot submit raw tool/history content through a generic instruction field. Internally, contexts carry immutable source manifests and policy/audience versions. A handle is scoped to its guild, destination, purpose, and source version; `derive` reauthorizes for a different purpose rather than treating it as a reusable permission token. Handles need not persist across restart; reconstruct them from authorized sources.

Mandatory-boundary rules:

- Construct raw main, utility, decision, embedding, and image transports only inside the gateway/composition module. Do not inject them into application services.
- Restrict imports with lint/dependency rules. Add architecture tests covering provider creation and calls, including summary/extraction, attribution repair, fallback attempts, character generation, external reranking/embedding, and generated-image requests.
- Runtime-check handle registration, purpose, destination, policy/source versions, and invalidation on each call. Reject forged/unregistered/stale handles; never accept a caller-set `filtered: true` flag.
- Perform prompt serialization inside the guarded boundary. Context changes from character modules, tool results, and overflow summaries must go through authorization again; no mutable post-guard `ChatRequest` additions.
- Guard each external call within provider-internal tool loops and retry chains. A check around only the first call is insufficient when tool results or permissions change.
- Keep retrieval authorization before expensive/external processing. Authorized compaction calls go through the same gateway and return derived, provenance-bearing sources.
- Recheck before delivery and persistence. Cancel/rebuild if eligibility changed after dispatch; bytes already sent to a provider cannot be retroactively withdrawn. Minimize that window with version checks and invalidation, without claiming impossible atomicity across Discord and external APIs.
- Require source registration and policy coverage for new context types. Maintain an architectural invariant test rather than relying on a checklist in each feature.

This prevents accidental bypass through ordinary application APIs; it is not a claim that TypeScript types can stop arbitrary newly written network code. Import/network boundary tests, code review, runtime checks, and complete migration are necessary to keep the invariant true. During migration, legacy raw calls are explicit tracked gaps; do not describe enforcement as complete while any remain.

## 4. Acceptance gates

- Payload-capture tests use a fake provider transport and synthetic content; production telemetry contains no captured prompts/responses. Test the final serialized payload, including retries and tool continuations, rather than only pre-serialization objects.
- The reliability plan's minimum privacy contract passes for every source enabled in expanded context. Track deferred/excluded sources explicitly; tracked gaps do not count as passed gates.

- Restricted source sentinels never appear in captured provider payloads across reply, decision, summary, extraction, tool continuation, repair, embedding, or image-generation tests.
- A restricted source cannot return through a summary, old bot quote, cached result, relation, or character overlay.
- Forged/stale/cross-audience handles fail at runtime; raw-provider imports and unguarded application calls fail architecture checks.
- Permission changes between preparation, tool execution, retry, and delivery cancel or rebuild the affected turn. Existing action authorization still applies independently.

## 5. Acceptance scenarios

| Scenario | Required result |
| --- | --- |
| Read permission/role removed during generation | Cancel prohibited delivery/context use; report safe diagnostic outcome |
| Restricted author appears in history, reply chain, or quoted bot output | Exclude their protected source content and known dependent facts consistently in every mode |
| Readable message has both eligible and ineligible reactors | Include only eligible reactors and recomputed counts; use filtered count for thresholds |
| Reaction target is unreadable | Exclude target text and associated reaction context; no reconstruction through emoji |
| Daily/overflow summary combines eligible and restricted sources | Include only independently eligible attributed claims; rebuild/exclude an inseparable summary |
| Member permission or forgetting state changes after summary/memory creation | Invalidate dependent memory, summary, cache/index, session-derived content, and character state before reuse |
| Allowed request retrieves a private or isolated fact for a public channel | Do not disclose it merely because bot/requester can read it elsewhere |
| Tool or decision model receives candidate context | Same pre-model filtering as final answer generation; no hidden data used for ranking or deciding to speak |
| Legacy summary has no source provenance | Exclude or safely rebuild; do not assume it is public because it was previously stored |

## 6. Sequencing

| Phase | Deliverables | Exit criteria |
| --- | --- | --- |
| A: Inventory | Enumerate every producer and consumer in section 2 and every raw provider construction/call site | Each source has a documented privacy path or tracked gap |
| B: Guard and gateway | `ContextPolicyGuard`, `GuardedModelGateway`, import/architecture rules; migrate live reply and participation decisions first; bounded historical resolution | Synthetic fake-transport sentinel tests pass; production emits metadata only; each expanded source passes its activation gate; no new raw provider imports |
| C: Derived data | Provenance on bot/session output, summaries, memory, character state, caches; legacy tagging; invalidation service; deliver per source alongside B where needed | Required before expanded reuse/compaction for each affected source; restricted sources cannot return through derived records; unverifiable legacy material excluded until safely validated/rebuilt |
| D: Remaining consumers | Background summaries, extraction, tool loops, repair, embedding, image generation | Zero tracked raw-call gaps; all gates in section 4 pass |

Rollback must not restore a known privacy bypass. Each phase is a separate reviewable change.
