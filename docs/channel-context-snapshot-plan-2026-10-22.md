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
6. Before visible effects check snapshot freshness and forget state. Discord
   updates/deletions, permission/membership changes, disconnects and policy
   changes invalidate in-flight snapshots. Edits to unrelated utility panels
   are ignored; edits/deletions of admitted source IDs invalidate the snapshot.
   New messages alone do not invalidate
   the immutable context already collected.

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
