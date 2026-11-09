# Delivery policy and evidence refresh

This user-approved revision narrows the cancellation rules in the
[channel snapshot plan](channel-context-snapshot-plan-2026-10-22.md).
It applies to direct mentions, explicit replies, bare pings, name addresses,
implicit follow-ups, group participation, and reactions.

## Rules

| Change during generation | Behavior |
| --- | --- |
| Triggering user loses interaction access | Block delivery through current access policy. |
| Bot loses channel/history access, or chat/context scope is disabled | Block the affected turn. |
| Contributing author/actor opts out by ID or current role | Block disclosure of the excluded context. |
| Used source is deleted or explicitly forgotten | Block disclosure; unrelated subjects' forgetting does not cancel the turn. |
| Retention/isolation mode changes, or authorized shared-memory access is withdrawn | Block the affected context. |
| Relevant source text, attachment, or reply reference is edited | Reassemble and regenerate once before delivery; never send the stale draft. |
| Embed hydration, new ordinary messages, unrelated utility-panel edits | Continue. |
| Member/role/channel/thread event leaves actual access unchanged | Continue after checking current cached policy. |
| Persona, character prose, mood, style, or normal resource value changes | Finish using the authorized turn snapshot; future turns receive updated values. |
| Personal preferences explicitly removed | Treat removal as withdrawal of that personal material. |
| Conversation opportunity ages or another person speaks after generation began | Do not discard an otherwise authorized generated answer for that reason. |

The final authorization gate does not make a second social-participation decision.
Initial decisions can still select silence/reaction; malformed or ungrounded
provider output remains subject to existing output validation.

## Implementation

Interaction authorization uses `SocialChatEligibility.interactionPolicy` and
`ChatAccessService`. Collection uses the same role/user opt-out rules through
`collectionPolicyCurrent`, effective Discord permissions, and the captured
channel memory mode. Ordinary checks use local caches, not repeated history or
member REST scans. Gateway events trigger policy reassessment rather than an
automatic guild-wide veto. The generic event tracker retains conservative
invalidation for adapters that do not supply a current policy callback.

Live conversation configuration and resource values are immutable turn snapshots.
Participant access and explicit preference removal remain live checks. Background
callbacks, consolidation, and authored configuration mutations retain their
existing freshness/revision requirements; they are not granted indefinite
authority by a pinned conversation snapshot.

Reaction initiation is rechecked against the currently cached members: at least
one collection-eligible reactor must retain interaction permission. Another
reactor losing an interaction role alone does not invalidate readable context
when an authorized initiator remains.

At visible effects the port refreshes persistent forget tombstones and checks
current channel/game scope. Process-local forget checks examine contributing
evidence, rather than cancelling every turn in the guild.

The Discord port can reopen fresh evidence after an edit. The executor discards
the old draft, reruns assembly/decision/generation once, and records
`chat.context.refreshed` with `source_edited`. The retry shares the original
turn deadline and pinned authored configuration. A tool effect is marked before
execution, including uncertain failures; regeneration never repeats it. Once
delivery starts there is also no automatic replay.

## Limits and verification

Provider/transport errors, inability to verify access after a connection loss,
work/output limits, continuous edits beyond the single refresh, and uncertain or
already-started effects can still prevent completion. Those are operational or
evidence failures, not discretionary social silence or proof of user denial.

Regression coverage includes all seven actual Discord adapter paths for harmless
guild events and contributing-user opt-outs; revoked interaction/channel access;
disabled chat; relevant versus unrelated forgetting; persona/style updates;
current-message and historical-source edits; bounded regeneration; and preventing
tool replay. No live Discord request, deployment, or paid provider evaluation is
included in local verification. Production delivery still needs confirmation.

Final local verification: **5,184 passed, 7 skipped, zero failed** in
`node_modules/.test-tmp/policy-cancellation-verified.json`. Typecheck, complete
Activity/application build, changed-file ESLint, and whitespace checks pass.
No schema or migration changes were needed. The earlier no-reply trace lacks
the historical invalidator, so this revision is not proof of that event's exact
cause or confirmation that the server now replies successfully.
