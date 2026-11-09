# Channel context and collection opt-outs

This design supersedes the earlier requirement that every context author must
hold an AI interaction role. Discord channel visibility is the audience/privacy
boundary. Interaction grants determine who may trigger the bot; they do not
determine whose channel messages the bot may understand.

## Policy

- Keep channel-context, retention, feature and game-channel exclusions.
- Collect readable same-channel sources by default. Threads have their own
  Discord visibility. Do not copy learned context across channel boundaries.
- Apply explicit `chat.contextOptOutUserIds` and `chat.contextOptOutRoleIds`.
  Neither administrators nor bot owners bypass collection exclusions.
- Apply the same exclusions to replies, reactions, identities, summaries,
  memories and every contributing source of derived records.
- Preserve deleted/forgotten-source checks and origin/provenance verification.
- A restricted interaction role stops triggering; it is not a collection opt-out.

## Execution

1. Fast ingress authorization and routing reject ineligible triggers.
2. Collect a bounded, deduplicated Discord snapshot. Resolve each author once
   and filter each source once. Preserve IDs, authors, timestamps and replies.
3. Reuse the authorized snapshot across context selection, decision and reply.
4. A silent/reaction decision skips reply-only enrichment and text generation.
5. At model boundaries use lightweight snapshot/policy invalidation, rather than
   REST-refetching the complete history and membership for every nested helper.
6. Before visible effects check current authorization and forget state. Guild
   events require policy reassessment, not automatic cancellation. Actual access
   withdrawal, contributing-source deletion and opt-outs block delivery. Source
   edits request bounded reassembly/regeneration; ordinary new messages,
   presentation updates and persona/style changes do not cancel a valid answer.
   See the [delivery policy revision](chat-delivery-policy-plan-2026-10-22.md)
   for the complete matrix, retry boundaries, and operational limits.

## Checkpoints

- Policy separation and configurable role/user opt-outs: implemented; focused
  access, eligibility, settings and persistence tests pass.
- Snapshot reuse, invalidation and reply-only semantic work ordering: implemented.
  The direct-tag adapter regression delivers after 20 nested model checks with
  no extra Discord scans; 80 lease checks reuse a 40-message snapshot.
  Admission no longer walks reply ancestry.
  SQLite/PostgreSQL forget checks support one bounded query per source batch.
  Reaction collection includes non-triggering participants but requires an
  authorized participant to initiate a turn.
- Final regression/build verification and plan reconciliation: complete.
  Full suite: 5,150 passed, 7 skipped, zero failed. Typecheck, complete
  Activity/application build, migration consistency, changed-file lint and
  whitespace checks pass. Deployment/live Discord timing remains unverified.

## Operator settings and diagnostics

`/settings-memory context-opt-out` and the Memory settings panel expose excluded
roles and user IDs. `chat.contextOptOutRoleIds` and `chat.contextOptOutUserIds`
are persisted as lists; existing files default to empty lists. Clear users in
the panel with an empty field. Existing interaction restrictions remain in place.

`context.guard.validation.mode` distinguishes `snapshot` (reuse without Discord
history/member REST), `effect` (fresh forget checks plus snapshot/resource
freshness), and `full` (fallback for source adapters without event snapshots).
Logs contain IDs, counters, durations and policy status, never message bodies.

Decision context retains authorized history, memory and authored lexical lore.
Semantic example/lore retrieval is reply-only. Facts already supplied to
preflight are retained when adding semantic lore within the existing budget. Image input and bounded reply
compaction can still run before decision when needed for the supplied context;
the system does not make every semantic decision from the incoming text alone.

No live Discord actions or paid provider evaluation are part of local validation.

## Production follow-up: request approval with music roles

The supplied production trace for build `97e540e4`, source message
`1562554511988498574`, passes snapshot validation in 20–29 ms but fails before
the reply-model boundary, ending after 3.925 seconds without confirmed delivery.
Its generic `provider_error` classification does not establish a provider fault.

Reproducing the production music role fields exposed a `DataCloneError`:
initial request approval replaces native role sets with immutable read-only
views containing bound methods. Generation and text-only repair approve the
request again; those views must be rebuilt from their values, not passed to
`structuredClone`. Both empty and populated sets now survive approval and
repair while remaining immutable. A direct-turn regression includes the role
fields and verifies delivery. The logger now categorizes this exception as
`data_clone_error` without exposing exception text or request material.

The earlier turn fixtures omitted these production fields; prior passing tests
therefore did not cover this failure. This correction preserves channel
collection, explicit opt-outs, interaction permissions and source freshness.

Correction verification: **5,153 passed, 7 skipped, zero failed**; TypeScript
checking, complete application/Activity build, changed-file lint and whitespace
checks pass. All three added regressions failed with `DataCloneError` before
the fix. No deployment, live Discord send or paid model request was performed.

## Unresolved production follow-up: completed reply rejected at result gate

The next supplied production trace runs `4425dd74`, source message
`1562557266077421609`, trace `af30dae8-ab29-44bb-b844-43448c6846e8`.
The provider attempt completes in 8,452 ms, followed by a completed reply
operation, `model.gateway.rejected` at `result`, and a suppressed direct turn
after 12,520 ms with no confirmed delivery. This is not the role-set cloning
failure. The log does not establish a provider refusal or an intentional
silence decision, nor does it identify the failing eligibility condition.

New metadata-only diagnostics distinguish trigger, character/persona, and
context gate failures. Snapshot invalidation records an observed Discord
event category and, for source edits/deletions, the affected message ID.
The bounded shared tracker and authorization decisions remain unchanged.
Suppression uses the `guard_rejected` failure category; trace explanations
recognize the actual suppressed-turn sequence instead of labeling it a
provider failure after a completed provider attempt.

Local regression evidence covers generation followed by trigger or persona
invalidation, event-specific snapshot rejection, and the supplied result-gate
trace shape. Full suite: **5,157 passed, 7 skipped, zero failed**. The underlying
production invalidator remains unresolved and requires a trace from a build
with these diagnostics. No live reproduction or paid provider request was run.
