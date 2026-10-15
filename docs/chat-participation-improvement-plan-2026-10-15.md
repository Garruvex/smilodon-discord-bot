# Chat improvement: participation, memory and simpler settings

Date: 2026-10-15. Status: proposed; implementation and live acceptance pending.

This plan also owns the agreed memory improvement: gradually fade stale impressions without abruptly losing source-backed familiarity and shared history. Keep advanced cleanup controls out of the normal settings screen. See workstream 6 for behavior, migration and acceptance criteria.

Follow-up to [the believability plan](chat-believability-plan-2026-10-14.md) and [the operator guide](chat-believability-operations.md). Preserve spontaneous participation as a core feature. The goal is a character that can join a conversation naturally, sustain an exchange, and leave people room to talk.

## Problem and evidence

The bot treats too many messages as invitations to speak. It confuses relevance to a topic with being the intended recipient, and treats an opportunity to acknowledge something as a worthwhile contribution. Once it replies, its own output can sustain a continuation loop even when people have returned to talking to each other.

The supplied production log contains consecutive continuation decisions justified by briefly acknowledging a supplement, experiment, or joke. These are weak reasons to speak. Those particular continuation entries are labelled `Shadow participation decision`: they describe proposed replies, not confirmed Discord sends. Their accompanying `Ambient chat: replied` labels were misleading. The log does not establish which revision was deployed or provide enough message content to label every recipient correctly.

Current implementation weaknesses:

| Area | Current behavior | Consequence |
| --- | --- | --- |
| Recipient inference | Recent exchanges, reply links and model judgments establish possible continuation. | Same-topic messages can still be mistaken for messages to the bot. |
| Contribution threshold | Continuation accepts motivation >= 0.5; spontaneous participation requires >= 0.75. Model confidence must be >= 0.7 when a decision is available. | Routine follow-ups remain much easier to admit than spontaneous speech. Scores are uncalibrated self-ratings. |
| Failed decision | `allowsOptionalParticipation` admits continuation when the decision is null, including failed or invalid model output. | Locally inferred continuation proceeds to generation with no contribution assessment, enabling acknowledgment loops. Failure and an intentionally unconfigured provider are currently indistinguishable here. |
| Duplicate spontaneous thresholds | `prepare` uses `thoughts.threshold` (default 0.7) to propose reply/ignore, while baseline admission separately requires 0.75; the thoughts hook can apply its threshold again. | Multiple checks appear to control one decision, and the visible thought threshold is not the sole admission setting. |
| Inner thoughts | Candidate thoughts are generated on optional turns when the module is active, but their threshold does not independently gate continuation. Direct mentions do not use this thought loop. | Inner thoughts are not yet a general contribution filter for everyday exchanges. |
| Thought reservoir | Thoughts are held briefly, but held candidates do not independently determine whether the bot should speak. | Holding a thought does not reliably translate into better timing or restraint. |
| Timing and quotas | Continuation bypasses ordinary evaluation/text cooldowns and has separate default caps of 10 per exchange / 30 per 10 minutes. | Quiet activity does not substantially quiet an active continuation loop. |
| Channel scope | The bot owner bypasses chatbot-channel restrictions in the common access check, including observation and optional participation. Empty channel lists mean unrestricted access. | Configuring reply channels does not establish a strict passive-reading boundary. |
| Visibility | Background scans and daily summaries have separate channel selections; guild memories may be recalled across channels. | Reply channels, reading channels and shared-memory scope can be confused in settings. |
| Impression expiry and settings | Relationship impressions expire after 90 days by default; impression retention and old-version cleanup are exposed as ordinary settings. | Familiarity can disappear abruptly, while users must interpret internal maintenance controls. |

Already shipped on the working branch, not claimed deployed: `28391aba` removes the recent-reply shortcut, fixes current/future messages counting as prior participation, respects other recipients and rejects ambiguous continuation. `c89878eb` distinguishes previewed decisions, suppressed replies and confirmed text delivery in ambient logs. These are prerequisites, not proof that social timing is solved.

## Desired behavior

- Answer explicit requests and handle functional requests normally.
- Continue a clearly established exchange without requiring a mention on every message.
- Usually stay silent on acknowledgments, narration, repeated information and conversation-closing remarks.
- Allow occasional spontaneous contributions when the character has something specific to add and there is an opening.
- Treat an exchange between humans as belonging to them. A shared interest alone is insufficient reason to interrupt.
- Abstain when the recipient is uncertain. Silence is a successful result.
- Read and participate only within the relevant configured scope; keep channel history and thought state separate.

Non-goals: disable spontaneous participation permanently, maximize helpful answers, manufacture thoughts on every message, or make thresholds look like measured probabilities. Changing decision providers is outside this work.

## Proposed decision flow

Apply these checks in order, with final revalidation before any send:

1. **Scope:** is this channel, author and interaction eligible for observation or participation?
2. **Recipient:** is the message explicitly addressed to the bot, part of its active exchange, between other people, or unclear?
3. **Contribution:** would speaking add something specific, or merely acknowledge/repeat/fill space?
4. **Opening:** is there room to speak without interrupting, and is the contribution still relevant?
5. **Budget and delivery:** do the effective activity limits allow output, and do the recipient, context and settings still agree?

Never let a high contribution score override a failed scope check, an explicit other recipient, or an unclear recipient. For a spontaneous opportunity classified as an exchange between others, require both a strong contribution and a clear opening. Explicitly addressed functional requests must not be delayed behind optional social evaluation.

## Workstream 1: recipient and exchange tracking

Replace the notion of a recent channel reply with an active exchange carrying its initiating human message, participants, reply branch, last human engagement, last answered human message and recipient-specific expiry. A confirmed bot reply can open a response window for the person it answered, lasting 90–120 seconds from delivery (initial shadow experiment: 120 seconds). It can do so only once for each newly accepted human message; another bot message without intervening human engagement cannot renew the window or recruit bystanders. This gives someone time to read and type a Chinese response without creating a self-sustaining bot loop.

Use reply links and explicit mentions as strong evidence. Use chronology, speaker changes and topic continuity as supporting evidence. Questions, second-person pronouns, prior participation and bot-name references are insufficient by themselves. Distinguish mentioning the character in third person from addressing it.

Resolve plain names such as “Bob, did you…” against eligible observed aliases and participant/display names in the current context. Apply the existing audience, expiry and module-ownership filters before using an alias; it must not leak a private or isolated association. A name must be used as an address, not merely mentioned. Multiple plausible matches, or a likely address that cannot be resolved, produce `unclear` rather than guessing. Explicit Discord reply/mention evidence takes precedence.

End implicit continuation when another recipient is resolved, another reply branch takes over, the conversation closes, or the recipient-specific window expires. Interleaving speakers makes an unlinked follow-up ambiguous; an explicit reply to the bot can still establish its recipient. Do not implement this as a universal ban on group conversations.

Extend the structured decision with separately validated recipient evidence, recipient confidence, contribution assessment, opening assessment and target confidence. Evidence and targets must reference supplied eligible messages. Reject invented evidence and future messages. A human saying “I am talking to someone else” must end continuation; do not convert that correction into a durable member fact.

**Acceptance:** adding a question mark or “you” to a human-to-human exchange never makes it bot-directed. Clear linked replies still work. Alice's response at 50–60 seconds after her earlier message remains eligible when the bot answered her at 8 seconds; a contribution assessment still decides whether to speak. Extra bot output without another human message cannot renew the invitation. Plain-name addresses to Bob are recognized; ambiguous aliases abstain. A confident model cannot override an explicit other recipient.

## Workstream 2: inner thoughts as a contribution filter

Separate recipient classification from the character's wish to contribute. A single bounded structured call may produce both, but return distinct fields and apply distinct rules. Candidate generation and rating remain model self-assessment, not independent validation.

For optional continuation and spontaneous turns, form zero to three short candidate contributions. Zero is a valid and common result. **Contribution labels are the primary gate:** acknowledgment-only, repetition, generic advice, speculative help, topic hijack and stale information reject regardless of score. Numeric scores rank and, when configured, prune only the surviving eligible candidates; a 0.99 rejected candidate still cannot speak. Do not treat models' frequent 0.8–0.9 self-ratings as proof of useful contributions.

A candidate must identify its source message, intended recipient or group, and what it adds. It may be a relevant joke, opinion, personal reaction or useful observation; usefulness must not mean “acts like an assistant.” No factual claim should become stronger simply because it was held as a thought.

Use accepted candidates to guide optional reply generation and validate that the generated reply still serves the accepted contribution. Apply this filter to continuation too. On explicit direct turns, use a lightweight response instruction/post-check for acknowledgment loops and conversation endings; do not require a separate thought call or suppress an explicit question/tool request merely because an optional threshold was not met.

Contribution assessment on continuation adds no extra decision request to the current `prepare` flow, which already calls the provider. Labelled candidates enlarge its output and may increase tokens and latency. Reuse that request rather than introducing an independent scoring call. Keep candidate generation optional; the baseline labelled contribution check must not depend on enabling the inner-thought reservoir.

Held thoughts are ephemeral, bounded and partitioned by guild, channel, reply branch and recipient. Expire them on topic/recipient changes, source deletion or forgetting, access changes and context disablement. Never persist them as member memories. Re-evaluate a held candidate at a later eligible event; do not add autonomous background sends in this phase.

**Acceptance:** “lol,” “okay,” simple updates and repeated supplements do not create endless acknowledgment replies. Specific playful contributions remain possible. Direct requests retain their normal behavior and latency budget.

## Workstream 3: timing, restraint and settings

Give continuation a minimum interval and backstop caps rather than relying on spontaneous cooldowns. The contribution filter is the main defense against loops; quotas must leave room for ordinary back-and-forth without requiring another ping after two replies. Keep explicit replies responsive. Maintain a channel aggregate limit alongside branch-specific exchange limits, so switching branches does not reset the channel's output budget.

Starting **shadow-only experiment** values, not live defaults. Replay and human review choose the eventual settings:

| Control | Proposed starting value |
| --- | --- |
| Implicit exchange window | 90–120 seconds after a confirmed reply to that human; experiment starts at 120 seconds; renewal requires intervening human engagement |
| Contribution admission | Reject the listed weak contribution labels regardless of score |
| Unnamed continuation score | Compare existing 0.5 with stricter variants in labelled replay; no live cutoff selected |
| Spontaneous score | Compare existing 0.75 with stricter variants in labelled replay; no live cutoff selected |
| Recipient confidence | Evaluate against recipient labels separately from contribution/target scores; no new live cutoff selected |
| Spontaneous opening | Explicit positive assessment required |
| Optional continuation interval | At least 15 seconds between delivered replies |
| Optional continuation cap | Compare 4–6 per exchange (initial experiment: 5) / 12 per channel per 10 minutes |
| Consecutive marginal contributions | At most one among otherwise eligible candidates; define the marginal score band from replay. Rejected labels remain forbidden, not granted one free reply |

These are experiment settings, not calibrated cutoffs. An explicit reply or mention follows the direct-request path and does not expire merely because the implicit window elapsed.

Distinguish decision availability from decision outcome:

- **Configured provider failed or returned invalid output:** use the existing utility fallback if available; if all attempts fail, abstain on optional continuation and spontaneous turns. Never treat this as permission to use an ungated local continuation path.
- **No effective decision provider configured:** this is a valid explicit-chat setup. For this plan, optional continuation and spontaneous participation depend on an available structured decision provider (including the utility fallback). Settings must show them as paused with a clear dependency explanation. Do not require the character master switch or inner-thought module just to satisfy this provider capability. Mentions, explicit replies and functional requests remain usable. A local-only continuation implementation is out of scope.

Return distinguishable `unavailable`, `failed` and `valid` decision outcomes so logs and settings do not infer provider state from a null result.

Make the settings cleanup concrete:

- `chat.participation.spontaneousThreshold` is the **single** configurable spontaneous score cutoff, exposed as “Spontaneous contribution threshold” at `participation.controls.spontaneous-threshold`.
- `chat.participation.continuationThreshold` replaces the fixed continuation 0.5, exposed as “Follow-up contribution threshold” at `participation.controls.continuation-threshold`.
- Remove `character.modules.thoughts.threshold` from the public UI and from live admission. Retaining a thought uses the same eligibility labels and the relevant participation policy, not a second competing admission cutoff. Keep thought enable/shadow/hold controls; threshold tuning belongs under advanced participation settings.
- Centralize the effective policy used by baseline admission, `prepare`, thought selection and generated-reply validation. There must be no fixed hidden 0.75 check after a configurable spontaneous threshold, and no separate fixed continuation threshold.
- Define a compatibility mapping for existing stored `thoughts.threshold` values, explicit new values taking precedence. Preserve the former effective restrictive behavior where applicable rather than silently activating more speech; surface the mapping in upgrade notes. Retain a deprecated read path only as needed for migration, not a second runtime gate.

Explain that scores apply only after labels and recipient evidence pass. Activity presets should visibly cover both spontaneous and optional continuation limits. Translate the labels, provider dependency and advanced descriptions consistently. Avoid adding ordinary-screen controls for every internal heuristic.

**Acceptance:** Quiet activity reduces optional continuation as well as spontaneous output. Changing a thoughts setting cannot silently change a direct request into a dropped turn. Increasing a threshold never increases optional admission on the same recorded decisions.

## Workstream 4: strict and understandable channel scope

Separate explicit-request access from passive observation and unsolicited participation. Preserve owner access for explicit requests where intended; remove the owner bypass for passive observation and optional participation. Apply the boundary before reading history, scheduling social evaluations or sending anything.

Keep spontaneous participation's explicit channel allow-list. Define continuation/observation scope and empty-list semantics explicitly; prefer no passive participation until a scope is selected. Respect memory-disabled channels. Define thread inheritance versus explicit thread selection consistently and test it, rather than assuming parent-channel permission allows every thread.

Show background scan and daily-summary channels separately in settings. Shared guild memories may inform a response only within their established audience rules; they must not grant permission to read another channel or share private/isolated evidence. Settings should state this distinction in plain language.

Existing configurations need a compatibility review and clear upgrade behavior before changing empty-list semantics. Do not silently broaden reading scope, enable modules, or activate live participation during an upgrade.

**Acceptance:** an owner posting in an unselected channel causes no passive observation, social evaluation or unsolicited reply. Allowed direct requests still work. Background jobs only read their own configured eligible scope. Threads and private/isolated memories cannot cross boundaries accidentally.

## Workstream 5: evidence and human acceptance

Use the existing replay/evaluation tools with synthetic fixtures first, then consented real examples. Include Traditional Chinese short phrases, 50–60-second reading/typing delays, exchanges lasting four to six replies, multi-message bursts, multiple humans, group jokes, plain-name addresses, ambiguous aliases, third-person bot-name references, explicit replies, images and missing context. Mark ambiguous cases as ambiguous rather than inventing a ground truth.

Record proposal versus outcome separately: recipient class and evidence, contribution/opening judgments, rejection reason, proposed action, effective limits, shadow state and actual delivery. Avoid logging full thought text or private message content by default. Bound evaluation record retention and honor forgetting.

Compare the current branch and proposed changes on identical contexts. Human reviewers judge recipient correctness, interruption, repeated acknowledgment, missed explicit requests, persona fit and whether a spontaneous contribution was welcome. Count evaluation calls and added latency too. Lower message volume alone is not acceptance.

Required deterministic regressions:

- Another person's reply/mention and unresolved targets cannot be overridden by model scores.
- Plain-name addresses use only eligible aliases; ambiguous matches abstain and third-person references do not create an address.
- Current/future messages and bot output cannot manufacture prior human engagement.
- Each newly accepted human message authorizes at most one recipient-specific window renewal; duplicate or extra bot output cannot renew it.
- Rejected contribution labels stay rejected at every numeric score; reservoir settings cannot bypass the shared participation policy.
- Closing remarks and repeated acknowledgments do not prolong optional exchanges.
- Speaker, branch, source, access and settings changes cancel stale pending output and thoughts.
- Limits are enforced under concurrent opportunities and across branches; only confirmed delivery consumes delivered-output quotas.
- Configured-provider failures and invalid output abstain on optional turns; no-provider setups show optional paths paused while explicit requests remain available.
- Old threshold configuration maps once into the shared policy; new settings take precedence and no hidden second cutoff remains.
- Disabled/shadow modules cannot bypass the baseline recipient guard or produce live output.
- Owners, empty channel lists, threads and background scan scopes have explicit boundary tests.
- Trial decisions and suppressed output are never logged as delivered messages.

Initial human acceptance targets, to agree before the pilot: no explicit-other-recipient interruptions in labelled cases; no channel-boundary violations; substantially fewer unwanted acknowledgments than baseline; and no material loss of correct explicit-request responses. Also require reviewers to identify welcome spontaneous contributions. A system that simply becomes silent fails the feature goal.

## Workstream 6: fade impressions without erasing shared history

Agreed direction on 2026-10-15. Workstream 6 is implemented locally; deployment and human acceptance remain pending. See [implementation and bounded migration notes](relationship-memory-fading.md). The previous runtime gave relationship impressions a hard expiry when written (default 90 days). Replace that abrupt expiry with gradual reduction in their retrieval priority. Age alone should not turn a returning regular into a stranger.

- Distinguish time-sensitive interpretations (current interests, recent familiarity or tone) from source-backed familiarity and shared events. Fade the former as evidence gets older; retain the latter while their supporting records remain eligible. Derive these from actual sources rather than treating generated summaries as independent evidence.
- Fading controls whether an impression is useful to bring up, not whether its statement is true. Do not invent new details, strengthen confidence, infer current preferences from old interests, or present an old impression as a current fact.
- Use elapsed time since supporting human evidence was created or genuinely reinforced. Reading an impression, mentioning it in a bot reply or regenerating the same summary must not make it fresh. New eligible human evidence can refresh the supported parts only.
- Preserve all existing provenance, audience, expiry, correction, forgetting and access checks. If supporting evidence is deleted, expires or becomes inaccessible, invalidate the affected impression immediately rather than fading it slowly. Retaining shared history never overrides a user's deletion request or the source's own retention policy.
- Keep old-version cleanup separate: the existing 90-day cleanup of inactive/replaced module records is storage maintenance, not an expiry for active familiarity or ordinary member facts.
- Keep normal settings simple. Replace the impression-expiry control with an explained fading behavior; keep any tuning and old-version cleanup under advanced memory settings. Reuse the existing fading policy where appropriate, with one effective policy rather than competing relationship expiry and fading settings. Choose decay values through replay before setting live defaults.
- Define an explicit migration for existing relationship records with hard expiries; changing defaults must not leave the old 90-day deletion path active for those records. Remove only the expiry introduced by the relationship-retention policy, preserving independent source expiries and privacy boundaries. If legacy expiry reasons cannot be distinguished, document and review a bounded migration rule rather than blanket-clearing expiries. Already deleted records cannot be restored without remaining eligible sources and normal regeneration checks.

**Acceptance:** fake-clock cases across day 89/90/91 and longer absences show gradual retrieval changes without a sudden loss of source-backed familiarity. A returning regular's shared history remains available when relevant; old transient interests are not asserted as current preferences. Bot-generated refresh loops cannot reset evidence age. Correction, forgetting, source expiry and scope changes still invalidate affected derived data immediately. Upgrade tests cover existing expiry values and inactive-version cleanup separately. Human review confirms familiar recognition without stale or intrusive callbacks.

## Implementation order and rollout

1. Establish replay fixtures and document current effective settings. Keep the existing recipient/logging fixes as baseline.
2. Implement scope separation and exchange/recipient tracking, including race-time revalidation.
3. Implement contribution assessment for both optional paths and conservative provider-failure handling.
4. Add timing controls and clarify participation/thought settings with consistent translations.
5. Validate held-thought lifecycle and generated-reply alignment.
   Implement workstream 6 as a separate memory change with expiry migration, fake-clock lifecycle tests and simpler settings. It does not need to block participation shadow replay, but must pass its own checks before activation.
6. Run automated checks and matched replay comparisons; inspect failure cases before choosing thresholds.
7. Run shadow evaluation in one explicitly selected channel with spontaneous participation configured. Report hypothetical output honestly.
8. With operator approval, pilot live participation in that channel. Review unwanted interruptions and welcome contributions together, then expand only if people prefer the result.

No model-provider migration, unrelated module rewrite or live configuration change is required to create this plan. Implement changes in reviewable steps. Preserve existing local settings-copy work. Rollback is disabling optional participation in the pilot channel or reverting the behavioral changes; do not remove memory data.

## Definition of done

The bot can join a conversation without needing a mention, but does so selectively. People can finish talking to each other without being intercepted. Ordinary exchanges do not turn into acknowledgment loops. Direct requests remain dependable. Reading scope is predictable, settings describe actual behavior, and evidence distinguishes thinking about a reply from sending one. Automated boundaries pass and the human pilot prefers the resulting behavior; passing tests alone is not completion.
