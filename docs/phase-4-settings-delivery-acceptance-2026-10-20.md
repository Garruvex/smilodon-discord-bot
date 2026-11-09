# Phase 4 settings and delivery acceptance

Status: Phase 4 is complete locally on 2026-10-20. This record supersedes the remaining Phase 4 items in the two 2026-10-19 checkpoint records. Nothing was deployed, no slash commands were registered against Discord, and no guild configuration or read scope was changed. Phase 5 live evaluation and rollout remain unverified.

## Completed interfaces

`/settings-participation policy channel:<exact-channel-or-thread>` provides overview, context, and activity views. It explains dependencies, inactive versus configured/preview/unknown states, channel inheritance/overrides, history access, source exclusions, count/character/work bounds, memory mode, independent background scope, cooldowns and quotas. It is a read-only settings surface with current requester access checks. New views and descriptions are available in English, Traditional Chinese, and Japanese. Legacy-only gap/window/summary controls are labelled accordingly. Existing configuration defaults and migration behavior remain intact.

`/explain-message message:<id-or-same-channel-link>` adds the following access contract without expanding the existing detailed diagnostic command:

| Viewer | Access | Returned information |
| --- | --- | --- |
| Message author | Fresh current channel/history permission for viewer and bot, current diagnostics feature, unrestricted current membership, and an existing same-guild/channel message authored by that viewer | Redacted recorded outcome, partial-evidence notice, and a general notice if another retained attempt confirms delivery. No trace IDs, reason codes, source lists, counts, role details, provider metadata, or message bodies. |
| Bot administrator | Same current permission/feature/restricted-member gates; a freshly resolved role must match this guild's configured bot-administrator roles | The same redacted result for another existing message in that exact channel, plus a pointer to the effective-policy view. Server administrative permission alone is not a new role grant. |
| Bot owner using `/diagnostic message` | Existing owner-only gate and current channel/history permission for viewer and bot | Existing richer explanation and bounded technical timeline. The new self-service command supplies no owner bypass. |

Source ownership/scope is resolved before retained records are queried. Membership and permissions are fetched again after source resolution, so removing an administrator role during the lookup prevents reading another person's records. Foreign links, deleted/unresolvable sources, missing permissions, restricted membership, or unverified scope fail closed without disclosing whether a trace exists. Deleted-source forensic lookup remains confined to the existing owner diagnostic boundary. The new command has no model tool binding.

Public explanations intentionally merge access/feature denials into a generic recorded gate. They do not describe another participant's privacy settings. The richer owner view retains the established distinctions between valid silence, failed decisions, confirmed/partial/unknown delivery, unsaved state, source invalidation, metadata failures, fallback, and incomplete records. Historical-source exclusion does not become a denial of the whole request. No raw conversation capture was introduced.

## Completed delivery and edit paths

The [delivery checkpoint](phase-4-delivery-reliability-checkpoint-2026-10-19.md) implements stable enforced nonces within each logical part's bounded retry sequence, permanent/rate-limit failure handling, separation of acknowledgment from bookkeeping, and accurate partial text. Those bounded guarantees remain the accepted contract: this work does not promise cross-process exactly-once delivery or eliminate unknown acceptance after a transport failure.

Music panels, admin-panel redraws, and streamed chat image previews now use the same `ChannelEditScheduler` instance in production wiring. Admin-panel message slots are transient but preserve channel budgets/backoff through scheduler retirement. Unchanged payloads skip edits. Queued writes recheck the configuration signature and target channel, so an outdated settings render is discarded after a configuration change. Admin-panel shutdown cancels waiting edits/heal timers, refuses new refreshes, and drains tracked refresh tasks before persistence closes.

Image preview creation, repeated image updates, final replacement, and preview-error replacement share one per-turn slot. Identical images skip updates. Finalization invalidates queued/late previews; updates cannot overwrite the final answer. Pending work rechecks eligibility before dispatch. Closing the turn drops queued preview work, including a first callback arriving after the turn ended. Create requests carry stable nonce identity; edits clear prior attachments and retain the message ID. Preview captions and partial-delivery notices are localized.

Mention replies that were already acknowledged are not replaced with a generic error after a later failure. Ambient replies similarly avoid sending a second public failure response after delivery or a delivered-state commit error. Existing private unsaved-exchange notes remain separate from retrying the response.

Audited boundaries: interaction acknowledgments and ephemeral/webhook responses use their existing serialized interaction paths and Discord REST handling; permission-overwrite edits are not message edits. One-off music-request status updates are not periodic refresh loops. This phase does not replace SDK-wide rate limiting or migrate unrelated campaign/game delivery. Already-dispatched network requests cannot be recalled by cancellation. No production edit-rate thresholds were increased.

## Verification and release boundary

Full Vitest suite: **4,679 passed / 7 skipped**. TypeScript typecheck, changed/new-file ESLint, settings registry/command metadata/localization checks, migration portability, and whitespace checks pass. Repository-wide lint retains the pre-existing unrelated errors documented in Phase 3.

New tests cover author/admin redaction and access isolation, role revocation during lookup, disabled diagnostics, restricted membership, foreign scope and missing sources, three languages, admin edit pacing/cancellation/stale configuration, image deduplication, preview/final ordering, delayed access rechecks, declared backoff, closed-turn work, and the first preview arriving after completion. Previous Phase 4 policy, retry, partial delivery, bookkeeping, scheduler, and panel regressions also pass. No test result is represented as a real-provider accuracy or live Discord delivery measurement.

The implementation checkpoints are reviewable local commits. Phase 5 must still evaluate actual models on approved synthetic cases, compare shadow behavior, verify live permissions/transport behavior, and run an explicitly scoped pilot before broader activation. `eligible_count` remains opt-in and its unavailable memory/summary/learned/image/tool sources remain excluded as specified in Phase 3. The universal context gateway remains a separate migration.
