# Phase 4 settings and explanation checkpoint

Status: effective-policy and protected message-explanation views implemented locally. Phase 4 remains in progress. No live settings, command registration, read scope, or deployment changed.

Subsequent work: [the delivery reliability checkpoint](phase-4-delivery-reliability-checkpoint-2026-10-19.md) now covers stable reply retry identity, confirmed partial text, and shared edit budget/backoff fixes. Its remaining-work list supersedes the delivery status at the end of this historical checkpoint.

## Effective policy

Administrators can inspect `/settings-participation policy channel:<channel-or-thread>` with `view:overview`, `view:context`, or `view:activity`.

- Overview covers direct mentions, bot replies, bare pings, name addresses, continuation, group conversation, and reaction follow-up. Shared blockers and mode-specific dependencies distinguish inactive, configured, unverified, and preview-only states.
- Context shows the actual selected builder, configured message/character budgets, exact observation scope and inheritance, channel overrides, memory mode, independent background scan/daily scope, and guarded-source exclusions and work limits.
- Activity shows resolved channel activity limits, cooldowns, continuation intervals, and quotas. Social-ping personality and continuation-failure preferences remain visible in the overview.

The report checks fresh requester channel/history permissions and requires a text-capable channel in the current guild. Bot history access is shown as a dependency rather than granting an owner bypass. No source messages, names, member role details, or hidden-channel lists are fetched. Role configuration is represented only as counts. A missing channel parameter displays selection instructions, including in the shared admin panel, rather than choosing a channel implicitly.

These views explain configuration and readiness. They do not authorize a turn or promise that the bot will reply. Current member/source eligibility, game/routing gates, cooldowns, live quota usage, and model decisions still apply. Unknown provider readiness is reported as unknown. The legacy direct path is not incorrectly assigned the guarded builder's fresh-history prerequisite. All report views are translated into English, Traditional Chinese, and Japanese and fit Discord's content limits.

## Protected message explanation

The existing owner-only, ephemeral `/diagnostic message:<message-id-or-same-channel-link>` now begins with a localized explanation and retains a bounded technical timeline. Current channel/history access for both requester and bot is still required before reading retained records. This checkpoint does not broaden diagnostic access to administrators or ordinary users.

The explanation distinguishes confirmed text delivery, observed parts with unknown completion, explicit partial delivery, delivered-but-unsaved state, confirmed reactions, valid silence, decision/model failure, access/scope denial, disabled features, duplicate suppression, source invalidation, interrupted work, and incomplete evidence. A `no_text_delivery` event alone is not intentional silence. Historical-source exclusion is not a denial of the current request. A generated silent decision followed by a recorded failure is not presented as intentional silence.

Context counts, declared excluded source classes, failed model-event records, and observed fallback remain visible after successful delivery. Failure counts describe diagnostic events rather than unique provider calls because different instrumentation layers may record the same attempt. The newest source group is selected by recorded time rather than insertion order; confirmed delivery in another retained attempt is called out. Truncation and missing records remain explicit. The result does not fetch conversation text or add prompt/response logging.

## Validation and remaining work

Local full-suite validation: **4,640 passed / 7 skipped**. TypeScript typecheck, changed/new-file ESLint, settings registry/metadata/localization validation, and whitespace checks pass. The repository-wide ESLint failures recorded in Phase 3 remain outside this change.

Tests cover exact channel/thread inheritance, empty scopes, channel overrides, disabled dependencies, unknown readiness, guarded exclusions, background-scope separation, shadow status, fresh permission denial/fetch failure, read-only behavior, all three languages and view sizes, confirmed/partial/unknown delivery, unsaved state, decision failure versus intentional silence, current versus historical denial, successful fallback, multi-attempt lookup, truncation, and existing owner-only lookup protections.

Remaining Phase 4 work: broader administrator/self-service message explanations with an explicit privacy/access contract; more detailed effective-policy and trace UI where needed; delivery retry deduplication, partial-delivery behavior, edit throttling, and their acceptance review. Phase 5 still owns live-provider conversation evaluation, shadow comparisons, and controlled activation. Neither this checkpoint nor the local suite establishes real Discord transport behavior or real-model conversational quality.
