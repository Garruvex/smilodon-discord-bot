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
   changes invalidate in-flight snapshots. New messages alone do not invalidate
   the immutable context already collected.

## Checkpoints

- Policy separation and configurable role/user opt-outs: implemented; focused
  access, eligibility, settings and persistence tests pass.
- Snapshot reuse, invalidation and reply-only work ordering: in progress.
- Final regression/build verification and reconciliation: pending.

No live Discord actions or paid provider evaluation are part of local validation.
