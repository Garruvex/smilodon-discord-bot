# Simple participation decision plan

Status: Phase 1 implemented on `codex/chat-believability-memory-isolation` (uncommitted, awaiting review); Phase 2 not started. Differences found while implementing are marked "As built".

## Objective and scope

Replace the optional-participation model's multi-field interpretation with one action choice: `reply`, `react`, or `ignore`. The same request carries an emoji choice that the app reads only when the action is `react`. The app owns eligibility, destination binding, authorized context, scheduling, budgets, and delivery. The model judges whether participation is appropriate in the supplied conversation, including recipient ambiguity and unresolved references.

Use native OpenAI Decisions or a dedicated `chat_completions` decision model when explicitly configured. Otherwise use the configured reply LLM's structured path with the same simple action contract, at a separate decision reasoning effort. Configuration fallback is distinct from retrying a failed request through another provider: a failed decision produces no optional action.

The goal is a fast, cheap check. Record end-to-end time from message receipt to delivery or abstention, not only decision latency.

Keep the existing implementation available for rollback. Stop tuning the previous synthetic benchmark as the implementation's acceptance target. Its reports remain historical evidence. The new binary benchmark is a narrower experiment, not an action/reaction or generation acceptance test.

Initial scope: optional participation on incoming human messages. Existing explicit requests, tools, and reaction-snapshot workflows retain their established paths. A reaction chosen in response to a human message is in scope; interpreting aggregated reactions to a bot message is not.

## Phases

The work ships in two phases. Phase 1 is everything a non-sending trial run can exercise. Phase 2 is what only matters once optional replies are actually delivered.

**Phase 1 — trial run.** The simple contract and action-dependent decoding; provider routing and the decision reasoning effort; the contract switch and simple-action thresholds; the linked and open-exchange follow-up rules, with open exchanges anchored on direct replies; inner thoughts formed, held and logged (steering the reply is Phase 2); and the decision and exclusion log events. Exit: the pilot channel has run as a trial long enough that its logged decisions have been looked over, and the operator is satisfied with unwanted replies, missed replies, wrong recipients and inappropriate reactions.

**Phase 2 — live optional delivery.** Stable exchange identity, delivery-anchored windows that a delivered follow-up extends, epoch-bound reservations and idempotent accounting (see Phase 2: exchange accounting). In a trial run no follow-up is delivered, so none of this can run: an exchange is never extended, never counts against `per-exchange`, and never meets delayed callbacks or duplicate deliveries. Gate: a short live step in the pilot channel with preview off and a tight `per-exchange` limit (for example 3), checked in the logs before the limit is raised. That step is the only way to observe extended exchanges.

Phase 1 must not depend on Phase 2. **In Phase 1 the simple contract always runs as a trial run**, whatever the preview switch says: for optional turns it calls the model, logs the decision and stops there: no reply text is generated, and no optional reply or reaction is sent. Setting `decision-contract simple` on one channel is therefore the whole trial; there is no state where the contract is set but nothing is evaluated. Explicit requests are unaffected. Phase 2 removes the always-trial rule, and from then on the preview switch applies to simple-contract channels as it does to legacy ones.

**As built (Phase 1).** The simple branch is `CharacterRuntime.prepareSimple`, entered for guarded optional message turns whose effective contract is `simple`; explicit requests, reaction snapshots and legacy channels never reach it. It runs after the existing admission stage, so a message that stage does not route (for example a joining message in a channel not on the joining list, when the old rules would treat it as joining) never reaches the simple decision; widening admission belongs with Phase 2. The log's `admission` values are `trial_not_sent` (model chose to act), `model_ignore`, `action_unavailable`, `reaction_selection_failed`, `below_threshold`, or the failure category when the call failed.

## Corrections to the proposed rationale

- Direct addressing bypasses optional social scoring, not permission, privacy, disabled-chat, or delivery constraints. It is not an unconditional promise to send a reply.
- `localAddressing` is a useful heuristic. Recent interaction does not prove that a new message addresses the bot; lack of recent interaction does not prove an older followup is invalid.
- The three actions are three choices. Asking for the emoji in the same request avoids a second round trip, at the cost of a slightly larger request. Smaller output does not guarantee cost or latency improvements; record actual calls and usage.
- Native probabilities and an LLM's self-reported confidence are different quantities. Do not present either as calibrated accuracy or apply an identical threshold to both without evidence.
- Approved input provenance establishes permission to use context. It does not prove the semantic claim that the current message addresses the bot. Do not label all supplied history as model-cited recipient evidence.

## Proposed configuration and routing

Keep contract selection separate from endpoint selection. Confirm naming against project conventions during implementation.

### Contract switch

The contract is chosen per guild and per channel, not only per instance, so one channel can pilot simple mode while other guilds on the same instance keep live legacy delivery.

- Instance default: `PARTICIPATION_DECISION_CONTRACT=legacy|simple`, defaulting to `legacy`.
- Guild override: an optional `chat.participation.decisionContract` (`legacy`/`simple`), set through `/settings-participation`. Unset inherits the instance default.
- Channel override: an optional `decisionContract` in the existing participation `channelOverrides`, set through `/settings-participation channel`. Unset inherits the guild.

The effective contract is resolved per turn (channel, then guild, then instance) and recorded on every decision log event. `/settings-participation policy` shows the effective contract and where it came from. A simple-contract turn needs a provider that supports the simple contract; if none is configured, the turn records `decision_unavailable` and takes no optional action rather than falling back to legacy.

### Provider routing

| Simple contract configuration | Selected provider | Failure behavior |
| --- | --- | --- |
| `DECISION_MODE=decisions` | Native `/decisions`, configured supported model | Record failure; no optional action; no generative fallback |
| `DECISION_MODEL` with `DECISION_MODE=chat_completions` (the current default) | Dedicated `/chat/completions` model with the strict simple action contract | Record failure; no optional action; no fallback to the reply LLM |
| No dedicated decision configuration | Configured reply LLM structured route at the decision reasoning effort below | Record failure; no optional action |
| No usable provider | Unavailable | No optional action |

A dedicated `chat_completions` model is the intended route for a small, cheap model. It uses the same strict enum contract as the reply route, so legacy dedicated configuration needs no migration to work in simple mode. Legacy-mode behavior of each route is unchanged.

### Decision reasoning effort

The reply LLM's structured route currently sends the main chat reasoning effort (`CHATBOT_REASONING_EFFORT`, medium on Pinecone) for every structured call. That is the main source of decision latency, and a simple contract alone does not remove it.

- Add `CHATBOT_DECISION_REASONING_EFFORT` (`minimal|low|medium|high`), defaulting to `CHATBOT_SUMMARY_REASONING_EFFORT`, which defaults to `low`.
- Apply it only to simple-contract decision calls on the reply route. Chat replies, summaries and other structured calls keep their current settings.
- A dedicated `chat_completions` decision model takes `DECISION_REASONING_EFFORT` where the endpoint supports one; native Decisions takes none.

Do not introduce automatic utility-model fallback in simple mode. Log effective contract, endpoint, model, reasoning effort and source at startup and in every decision log event. Do not hardcode a model choice; the reasoning default is an explicit, documented setting rather than a silent change to chat behavior.

## Processing flow

1. Resolve the event and run existing mandatory access/eligibility checks. Explicit requests continue along their existing direct path.
2. For optional turns, evaluate channel observation, participation settings, opt-outs, cooldowns, and action budgets before inference. Exclude unambiguous replies to another human and explicit recipient corrections. Preserve existing qualified handling of quotes, aliases, and mentions; do not turn every occurrence of another person's name into a hard exclusion.
3. Classify the turn as a follow-up or joining using the rule below. Apply that kind's switch, channel scope, cooldowns and budgets. If the turn's kind has no available action, skip the call. The model does not select a participation mode or enable a disabled route.
4. Bind the target to the current message, acquire the approved context lease, and construct the package below.
5. Ask the selected provider one request with two questions: the action (only available actions plus `ignore`), and the emoji (the verified allowlist plus `none`). When `thoughts` is enabled and `reply` is available, send the inner-thought request concurrently (see Inner thoughts on the simple route); it never delays or alters the decision. If no active action is available, skip inference altogether. App-owned action availability is enforced again on return.
6. Validate the response envelope and action first. An invalid/missing/refused action, whole-request refusal, timeout, or transport error is a failure, not a successful Ignore prediction. On valid `ignore`, discard the emoji answer and stop. Emoji-only validation failures must not invalidate a valid Reply or Ignore; use the action-dependent decoding rules below.
7. On native `reply` or `react`, apply the configured action-score gate, if enabled, to the selected action's probability only. Do not take the minimum of recipient, evidence, target, intent, contribution or emoji scores.
8. On accepted `react`, validate and use the emoji from the same answer. `none`, refusal, a value outside the allowlist, a missing answer, or invalid native emoji probability data means no reaction; record `reaction_selection_failed`, never a text fallback or a successful Ignore. There is no second model call; delivery still revalidates (step 10).
9. On accepted `reply`, ignore the emoji answer and generate through the normal chat provider with authorized context. Permit short answers and acknowledgments; do not require novelty, a contribution label, or a prewritten candidate. Generation may still abstain. When the inner thought was formed and is in use (see Inner thoughts on the simple route), add its app-written stance line to the reply's character context. Preserve output safety, source, tool, and delivery validation.
10. Revalidate access, context freshness, target existence, action availability, and delivery budgets immediately before execution. Never let inference override an expired lease or a consumed budget.

### Follow-up or joining

Use a new app-owned structural binding helper, not `exchangeBranch` as an eligibility test. The existing helper falls back to the last bot response to this author even without a reply link, so its root is not proof of an active exchange.

Apply these rules in order:

1. Explicit requests, including a reply to a bot message, use the existing direct path.
2. An unambiguous address to another human or an explicit exclusion such as “I wasn't talking to you” is denied. `isRecipientCorrection` identifies an exclusion; it must not establish follow-up eligibility. A complaint about the bot's behavior is not automatically the same kind of correction.
3. Classify as **follow-up (linked)** when the current message has an explicit reply-chain connection, entirely within authorized context, to an exchange containing a confirmed bot reply to this author. Another human's exchange does not confer that binding. The exclusion in step 2 takes precedence even when an older ancestor is a bot exchange.
4. Otherwise classify as **follow-up (open exchange)** when all of these hold:
   - the bot's most recent message in this channel, within authorized context, was addressed to this author: a direct reply to them, or a delivered follow-up admitted for them;
   - the current message arrives within the exchange idle window after that bot message (below);
   - no message from this author between that bot message and the current one is an unambiguous address to another human;
   - the current message itself is not excluded by step 2.
5. Otherwise classify as **joining**, with any recent-activity hints explicitly marked uncertain.

Linked and open-exchange follow-ups are one kind for settings and budgets. The decision and exclusion log events carry the basis (`linked` or `open_exchange`) so the logs can tell them apart.

### Exchange idle window

Today the scheduler keys reservations by `exchangeId` and resets the reply count after 120 seconds measured from its success callback; eligibility instead examines bot message timestamps. Phase 1 shares the duration; Phase 2 shares the identity and clock.

**Phase 1:**

- Introduce one shared constant (for example `exchangeIdleMs`) and use it in the scheduler reset, the open-exchange rule, `localAddressing`'s default and `conversation-episodes.ts`, with no change to legacy behavior. Do not make it a guild setting in this version.
- The window is measured from the anchoring bot message's confirmed platform timestamp, not from a reservation, the model's answer or a callback. Elapsed time `<= exchangeIdleMs` is inside the window; strictly greater is idle.
- The anchor is the bot's most recent delivered message to this author. In Phase 1 that is always a direct reply, because simple-contract optional replies are never delivered; trial decisions never move the anchor.
- Once the bot's latest message in the channel is addressed to someone else, the earlier exchange is no longer open; a linked reply can still bind to it under rule 3.
- **Restart:** any exchange whose anchor predates process start is closed for open-exchange eligibility. Linked follow-ups retain their structural classification in the Phase 1 trial; classification does not establish an available budget. Phase 2 applies the restart guard below before inference and delivery.

**Phase 2** extends this so a delivered follow-up becomes the new anchor and a back-and-forth stays open while each gap is inside the window, bounded by `per-exchange` and `per-10-minutes`. That requires the accounting below.

### Phase 2: exchange accounting

Only needed once simple-mode optional replies are delivered. The open-exchange rule and the scheduler then share both an exchange identity and an idle clock, not merely the same duration. Legacy scheduling behavior is preserved.

- Assign an app-owned `exchangeId` to a confirmed exchange, scoped by guild, channel, bot and human recipient. Its root is the original bound human event, not the latest bot response. Record the root/recipient association with the delivered message's origin record so a later anchor maps to the same identity, including after a restart. `message_origins` has no field for this today (it stores message, guild, channel, origin, `sourceMessageId`, creation time and `contextProvenance`), so Phase 2 adds nullable `exchange_id`, `exchange_root_message_id` and `exchange_recipient_id` columns, extends `MessageOriginRecord` and both stores, and leaves existing rows null. Null means "no known exchange", which suppresses a linked continuation rather than inventing one. Do not use `exchangeBranch`'s implicit fallback to invent a root.
- Each admitted continuation carries that identity through reservation, generation and delivery. Updating `anchorMessageId` after delivery never changes `exchangeId` or clears its reply count. Explicitly linked continuations inherit the mapped exchange identity too. Unknown or conflicting delivery metadata must not manufacture a fresh budget for an already active exchange; record the binding/accounting failure and suppress the optional turn.
- For simple mode, record one canonical `lastDeliveredAt`: the confirmed platform timestamp of the anchoring bot message. Pass it into the scheduler's success accounting and use it for the eligibility window. Reservation time, model completion time and callback execution time cannot extend the exchange. Initial confirmed direct replies establish the anchor without consuming an optional-follow-up count; successful optional text deliveries increment that count once.
- Use the same boundary convention everywhere: elapsed time `<= exchangeIdleMs` is inside the window; strictly greater is idle. Apply reset once for a new idle epoch, before reserving, while keeping the root identity. A delayed linked follow-up can reopen an idle epoch, but an ordinary new anchor inside the current epoch cannot reset it. Channel/per-10-minute limits continue across epoch resets.
- Commit delivery ID, anchor timestamp and reply-count increment atomically/idempotently for scheduler purposes. Retried callbacks, duplicate events and multi-part output from one logical turn count once; later chunks cannot renew the anchor. Reactions, preview decisions, failed deliveries and model abstentions neither refresh the text-exchange anchor nor increment its optional text count.
- Carry the exchange ID and accounting epoch in reservation tokens. An old completion cannot release or overwrite a newer reservation/epoch. Concurrent turns reserve against the same exchange, and access/idle/availability checks are repeated before delivery.
- Restart keeps pre-start anchors closed for open-exchange eligibility. Since counters stay in memory, suppress linked continuations of pre-start exchanges until strictly more than `exchangeIdleMs` has elapsed since startup (`exchange_restart_wait`). This conservative wait covers the previous idle window even if the latest pre-start delivery is unavailable; an older visible ancestor cannot shorten it. Afterward, an authorized linked continuation may start a new idle epoch under the same verified root identity. Recover identity from delivery origin metadata, not counters; missing or conflicting identity still suppresses the turn. Genuinely new post-start exchanges are unaffected. This prevents refreshing an old active per-exchange allowance; it does not claim to persist channel rolling limits.
- Bound simple-mode accounting to 512 exchange entries initially. Evict only unreserved entries whose idle window has strictly expired and whose removal discards no still-applicable accounting. Never evict an active entry merely because it is unreserved. If no safe eviction exists, deny the new reservation with `capacity` and retain existing counts. Availability checks must agree with reservations. Preserve legacy eviction behavior separately. Recreating an expired entry uses its verified root and a fresh epoch token that stale callbacks cannot match.

Phase 2 tests must use an injected clock and distinguish event timestamps from delayed callback times. A sequence of delivered follow-ups can refresh the anchor while retaining one exchange ID and increasing the same count until the limit denies the next turn. Only a genuine idle epoch reset or a genuinely new, independently bound exchange can start a fresh per-exchange count.

### Binding properties

The binding is reconstructed for each turn from source IDs, explicit edges and the anchoring bot message. It is not renewed by an earlier model proposal, duplicate bot output, or a prior turn's admission; only a delivered bot message can move the open-exchange anchor (in Phase 1, only a direct reply). Missing/revoked/deleted anchors invalidate the binding. An explicit exclusion cancels the current turn. A later explicit request can start a new exchange. For linked follow-ups, time gaps alone do not invalidate an available authorized structural link; open-exchange follow-ups end with the idle window.

Open-exchange eligibility only permits the model to be asked. It does not establish that the message addresses the bot: the package marks the basis as `open_exchange` and asks the model to choose `ignore` when the message turns to someone else or starts an unrelated topic. Interleaved messages from other humans do not close the exchange by themselves; they are part of the context the model judges.

A follow-up uses the follow-ups switch, limits, and observed-channel scope. Joining additionally requires the joining switch, its channel allowlist, and `joining check-every`. A disabled kind skips inference; the model cannot promote a joining turn into a follow-up.

**Remaining tradeoff:** an unlinked message after the idle window, or after the bot has answered someone else, is joining even if it semantically continues the earlier exchange. If joining is disabled, it is missed. These messages appear as exclusion log events (see Trial run and logs); check their volume before changing the rule; do not silently weaken joining permissions to recover them.

Do not fabricate a legacy `followup` classification. Regression cases must include delayed structurally linked follow-ups; unlinked short answers inside, at and just outside the idle window; an anchor from before process start; a back-and-forth extended by delivered follow-ups (Phase 2); interleaved speakers; this author addressing another human mid-exchange; the bot answering someone else in between; replies to another human inside a bot exchange; independent bot complaints; and a new unlinked topic from a recently answered person (eligible to ask, expected `ignore`).

## Context and output contracts

Input contains:

- Bot identity and a short persona line.
- Current message, author identity, timestamp, reply-to relationships, and relevant mention metadata.
- The recent authorized messages counted by `/settings-character context decision-context` (5–20, default 10), with stable speaker IDs and display names, chronological order, relative time gaps, and bot/human distinction.
- The authorized reply-chain or exchange anchor needed to understand the current message, even if outside the `decision-context` window. Deduplicate overlapping history; use the existing token budget and expose truncation. Never fetch extra context outside the lease.
- The app-decided kind (follow-up or joining), the follow-up basis (`linked` or `open_exchange`), the recent-activity hint, available actions and the emoji allowlist. When a still-authorized held thought exists in the same scope and `shadow` is off, one app-written line naming its source message, stance and length. Describe uncertain hints as uncertain, not as established recipient facts.
- A short common participation policy: respond to appropriate requests/followups, respect explicit other recipients, resolve references only from supplied context, and allow brief replies.

The decision package does **not** include memories, guild knowledge, persona lore, persona drift, reply-chain summaries, relation chains, alias candidates or character module context. Today the guarded decision sends all of these as `supplementalFacts` (`character-runtime.ts`), which enlarges every decision prompt. In simple mode they go to reply generation only.

Native output is an action and an emoji, each with the endpoint's selected-option probability; only the action probability is gated. The LLM output (dedicated or reply route) is a strict object of an action enum and an emoji enum including `none`; its reasoning remains internal and is not parsed as evidence. A shared application result includes action, optional emoji, provider identity, score kind/value where available, usage, timing, and failure status. Destination IDs and source membership are attached by the app after validation, not authored by the model.

Use separate types for the simple result and the legacy `CharacterDecision`. Avoid filling obsolete fields with invented labels, empty candidate prose, or confidence 1. Adapt downstream consumers to the new result rather than retaining hidden legacy vetoes.

### Action-dependent decoding

Both adapters request action plus emoji in one call, but validation is conditional on the action. Validate request/model identity, envelope integrity, unique known answer names, and a valid action before considering emoji. Malformed JSON, duplicated/unknown answer names, a wrong model, and whole-request refusal remain failures.

- **Reply / Ignore:** accept a valid action even if the emoji field is missing, refused, `none`, outside the allowlist, or has malformed probability data. Discard it; do not expose arbitrary emoji content in diagnostics. The normalized result has no emoji.
- **React:** require a non-`none` allowed emoji and, for native output, structurally valid probability data. Its probability is diagnostic only and does not create an additional threshold. Failure records the proposed React and `reaction_selection_failed`, with no delivered action.
- **React unavailable:** exclude it from action choices, bind emoji to `none` when the transport cannot represent a singleton choice, and make no extra request.

The current native client validates every answer before returning and rejects any refusal or missing answer. Implement a simple-contract-specific decoder or an explicit per-question validation policy so an unused emoji cannot veto Reply/Ignore. Keep strict behavior for existing clients and benchmarks. Likewise, the LLM adapter must validate action independently instead of applying an unconditional required-emoji object parser. Preserve failure versus abstention in all records.

### Confidence policy

Native action probability is useful in the trial logs and as a single configurable gate per kind. Store these separately from legacy motivation thresholds: proposed `chat.participation.simpleActionThresholds.followup` and `.joining`, with corresponding optional channel overrides. Each value is a probability from 0 to 1; zero explicitly disables that gate. An unset channel value inherits the guild value; an unset guild value defaults to zero. Resolve each kind independently and show the value and its source in `policy` output. Never initialize these fields from existing legacy thresholds.

Initially collect scores in the trial with both simple gates disabled without treating a cutoff as validated. Choose thresholds from logged decisions, including ignored, low-score and excluded turns, so missed replies are visible too. Legacy motivation thresholds retain their values, names, and meaning throughout.

The LLM fallback returns no claimed native probability. Record confidence as unavailable and evaluate its action directly under the same app guards. If a future LLM score is introduced, identify it as self-reported and calibrate it separately. Do not fabricate probability 1 or reuse native thresholds for it.

## Settings mapping

How each current `/settings-participation` and `/settings-character` control behaves for a simple-contract turn. Legacy turns are unchanged.

| Setting | Simple contract |
| --- | --- |
| `follow-ups enabled`, `joining enabled`, `joining channels`, `observation-channels` | Apply as now, to the app-decided kind. |
| Existing `follow-ups threshold`, `joining threshold` | Legacy motivation thresholds only. Preserved but not consulted by simple mode. |
| New `simple-action-threshold followup|joining` (guild and channel) | Separate native selected-action probability gates. Zero disables; unset channel inherits guild; unset guild defaults to disabled. LLM routes have no probability, so these gates do not apply and `policy` says so. Never modify legacy thresholds when editing these controls. |
| `joining check-every` | Applies as now: human messages between joining decisions. Follow-ups skip it. |
| `follow-ups interval`, `per-exchange`, `per-10-minutes`, `pacing`, `reset-limits`, `resources` | Apply as now. Checked before inference and again before delivery. |
| `preview`, `channel preview` | Legacy turns: apply as now (off by default). Simple-contract turns: ignored in Phase 1, which always runs as a trial; apply from Phase 2. Simple decisions are logged either way. |
| `channel reactions` | Applies as now: removes `react` from the available actions. |
| `bare-pings` | Unaffected: bare pings are explicit requests. |
| `/settings-character context decision-context` | Sets how many recent messages go into the decision package. |
| `/settings-character context messages`, `budget` | Unaffected: they size the reply generation context. |
| `/settings-character thoughts` (enabled, shadow, hold) and its channel module choice | Apply to simple-contract turns as described in Inner thoughts on the simple route: `enabled` forms thoughts, `shadow` (default on) forms and logs them without using them, `hold` sets how long a held thought lasts. The stored legacy `threshold` stays legacy-only and is not consulted. Legacy turns unchanged. |
| `/settings-character channel module:callbacks` | Use it to keep callbacks quiet in a trial channel; callbacks are not covered by the trial. |
| New: `decision-contract` (guild) and `channel decision-contract` | Select `legacy` or `simple`; unset inherits (see Contract switch). |

Help text and `/settings-participation policy` show the effective contract, relevant threshold family, each value's source, and whether the selected provider supports probability gating. Mixed simple/legacy channels can be tuned independently. Clearing a channel override restores inheritance; explicitly setting zero disables a guild gate for that channel.

## Character modules

The character modules (all off by default) were reviewed for whether they help decide when to speak and how to reply. None improves the decision today; inner thoughts is idle on live turns, and several modules make the decision prompt larger. Changes, all Phase 1 unless noted:

| Module | Today | Change |
| --- | --- | --- |
| `thoughts` (inner thoughts, after Liu et al., CHI 2025) | Acts only through the decision (`onDecision`). The legacy decision requests thoughts only for unguarded turns (`character-runtime.ts`), every live turn is guarded, and the contextual contract always returns `thoughts: []`. So on legacy live turns it never holds or reuses anything, and it never controlled admission even when it ran. | **Keep it and make it work on the simple route** (see Inner thoughts on the simple route). The fast decision model forms a structured thought alongside the decision, the thought steers reply generation, and a thought the bot held back can be offered again at the next opening. Legacy turns and the legacy `thoughts` schema field are unchanged. |
| `mood`, `group`, `recall-style`, `canon`, `relationships`, `daily-sketch` | Add context text. On guarded turns that text is also sent to the **decision** model, with memories, guild knowledge, persona lore, drift, summaries, relation chains and aliases, as `supplementalFacts`. | **Simple mode: reply generation only** (see Context and output contracts). They shape how the bot speaks, not whether. Legacy mode is unchanged in Phase 1; a lean legacy decision package is deferred work, because it changes validated legacy behavior. |
| `voice`, `message-shape` | Edit the generated reply. | Unchanged. In Phase 1 they still apply to direct replies; `message-shape` only applies to optional replies, so it has no effect in a trial channel until Phase 2. |
| `callbacks` | Proactive "how did it go?" messages, needing memory sharing and follow-ups enabled. | Unchanged, and **not** covered by the trial: a trial channel with callbacks on still sends them. For a quiet trial, turn callbacks off in the pilot channel with `/settings-character channel module:callbacks enabled:false`. |
| `fading`, `evaluation`, canon/relationship learning, daily-sketch updates | Background work after replies. | Unchanged; not in the decision path. Learning runs after direct replies as now, and never after trial decisions, since nothing is sent. |

## Inner thoughts on the simple route

The `thoughts` module adapts Inner Thoughts (Liu et al., CHI 2025): form a candidate thought, rate how much the character wants to say it, hold it, and speak at a natural opening. The legacy route could not run it because the live decision returns no thoughts. The simple route can, because a fast decision model makes extra calls cheap. The aim is a better and shorter reply, and a bot that sometimes chimes in a beat later because it was holding something.

**A thought is structured, not prose.** It is a `stance` and a `length`, chosen from fixed lists by the same decision model:

- `stance`: `answer`, `agree`, `add`, `joke`, `comfort`, `ask_back`, `acknowledge`, or `none` (nothing to say).
- `length`: `one_line`, `short`, `normal`.

Fixed lists work on native Decisions as well as on the LLM routes, which a free-text thought would not (native returns no text). They also keep invented prose about members out of state, logs and prompts. Free-text thoughts on LLM routes are deferred.

**Forming it.** When `thoughts` is enabled in the channel and `reply` is an available action, send one extra request concurrently with the decision request: same provider route, same decision package, same reasoning effort. Total latency stays that of the slower request, not the sum. For native Decisions the want-to-say rating is a third question, `wantsToSay`, answered as a probability (optional: a refusal only drops the rating); LLM routes give no rating and the stance is used directly. *As built:* a predicate question rather than "1 minus the probability of `none`", which a single selected-option probability cannot give. The thought request fails independently: a failed, refused or invalid thought is recorded and ignored, and never changes or delays the decision. It is not retried.

**Using it.**

1. **Steering the reply.** When the decision is an admitted `reply`, `shadow` is off and the stance is not `none`, add an app-written line to the reply's character context from the two enums (for example "Planned approach: a short agreeing reply"). Never pass model-written text. The line guides the normal chat model; it does not replace it, and generation may still abstain. A `reply` with stance `none` generates as usual. `length` is prompt guidance first; whether it also earns a lower output-token cap is decided from measured results.
2. **Holding.** When the decision is `ignore` but the stance is not `none`, store `{sourceMessageId, recipientId, stance, length, expiresAt, scope}` in the module's reservoir: at most three entries per channel, `hold` seconds (default 120), ephemeral, never written to memory or disk. The scope is guild, channel, the speaker and, for a follow-up, the exchange anchor (joining uses "channel"). *As built:* the legacy `exchangeBranch` root changes with every message that has no exchange, so it cannot scope a held joining thought. Drop an entry on source deletion or access change, context disable, a change of speaker or recipient, expiry, and restart.
3. **Reassessing.** At the next eligible simple decision in the same scope, if a held thought's source is still authorized, add one line to the decision package (for example "Earlier you held back from replying to message M with an agreeing short reply"). The model then picks reply, react or ignore as usual. The held thought never admits a reply, never overrides an exclusion, budget or availability check, and never lets the model reach a disabled kind. It makes no timer-driven send: there is no autonomous reply without a new message, as before.

**Not changed.** Thoughts never gate admission and add no threshold. The legacy `threshold` setting stays legacy-only. The `shadow` setting (default on) forms and logs thoughts without using them, so the operator can watch them before they affect any reply. Thoughts keep their existing module dependencies (conversation context, decision, participation) and are cancelled by the same events as before.

**Cost and limits.** One additional small request per eligible turn that has `reply` available. It counts toward the participation concurrency limit and appears in usage and the decision log. It does not count as an optional turn for `optional-turns`. Measure the added cost in the trial; if it is not worth it, set `thoughts` off.

**Phase placement.** Phase 1 (trial) forms, holds and logs thoughts, and, with `shadow` off, offers held thoughts to later decisions. No reply is generated, so steering the reply is Phase 2.

## Authorization and privacy

Keep `GuardedConversationContext`, approved model operations, and source invalidation active for every call, including the decision request and generation. The simple decision binds to the current event and an app-owned manifest of the exact supplied sources/context version. Validate that manifest against the active lease and target.

Add a simple-contract validator alongside the existing `decisionSourceFailure`; do not disable that function globally. The manifest records supplied sources, not evidence selected by the model. Downstream `referentSourceIds` must not automatically become a claim that all supplied messages substantiate the reply. Preserve generation's source validation and access checks independently.

Never include opt-out, revoked, deleted, cross-scope, or otherwise unauthorized sources in a provider request. Tests must exercise revocation between the decision and generation, and between generation or reaction choice and delivery.

## Trial run and logs

In Phase 1 every simple-contract channel is a trial run: the bot makes every simple decision but sends nothing for optional turns. `@`mentions, replies to the bot and bare pings still send. The preview switch (`/settings-participation preview`, off by default) keeps its current meaning for legacy channels and, from Phase 2, for simple-contract channels too.

Trial decisions are checked in the backend logs. There is no review command, review storage or labeling workflow in this plan.

- **Decision log:** each model-called simple decision emits one structured log event (for example `chat.simple_decision`) with decision ID, contract, provider/model and reasoning effort, follow-up or joining kind and basis, available actions, proposed action, emoji if any, score and score kind (or "unavailable" for LLM routes), admission outcome and reason, preview flag, latency, usage, and the source event ID and channel. When inner thoughts ran: stance, length, want-to-say score (native only), outcome (`used`, `would_use` in a trial, `shadow`, `held`, `discarded` or `failed`), whether a held thought was offered, and the thought request's own latency and usage. These are enums and numbers, so they carry no message content.
- **Exclusion log:** optional turns skipped before inference emit a lighter event (for example `chat.simple_exclusion`) with kind, basis if any, and the exclusion reason, and no model fields. Emit it only in channels whose effective contract is `simple`, at debug level, so legacy channels add no log volume and the trial channel can be inspected by raising the log level. Privacy and access denials log only the reason, never source IDs.
- **Log levels:** decision events are info level, exclusion events debug level. Startup logs the effective route at info level, as now.
- **Never in logs:** message content, transcripts or emoji text from a discarded answer. Source IDs let an operator open the message with their own Discord access.
- Distinguish "model proposed reply", "app admitted reply" and "text was generated/delivered" in the outcome field, and never log a skipped call as a model Ignore.

The existing evaluation store, `/character-eval` and "Felt like a bot" are unchanged.

## Implementation sequence

Phase 1:

1. Add simple request/result types, the instance contract default, `CHATBOT_DECISION_REASONING_EFFORT` and `DECISION_REASONING_EFFORT`, provider selection for all three routes, startup validation, and effective-route diagnostics. Primary files: `chat-provider.ts`, `contextual-decision-providers.ts`, `configuration.ts`, `environment.ts`, the Responses provider's structured call, and bootstrap wiring.
2. Add guild/channel contract overrides and separate simple-action thresholds to the participation schema, `resolveParticipation`, and `/settings-participation` (including inheritance and `policy` output). Preserve all legacy threshold values. Add per-turn contract resolution.
3. Add authorized context packaging, current-message binding, and linked/open-exchange eligibility anchored on direct replies, with the before-startup closure rule. Introduce the shared idle duration without changing legacy behavior. Review `character-decision.ts`, the scheduler, guarded context and approved-model transport.
4. Implement the one-request action-plus-emoji contract with action-dependent decoding for native Decisions, the dedicated `chat_completions` route and the reply route. Preserve existing strict decoding for legacy consumers. Report usage for every call, including failures.
5. Add simple admission/finalization integration in `conversation-decision-engine.ts` and `character-runtime.ts`. Audit every downstream use of contribution labels, recipient evidence, confidence, and target fields so the simple path cannot hit legacy scoring requirements. Apply the settings mapping and independently stored simple-action thresholds. Make the simple contract always run as a trial in Phase 1: model called, decision logged, no optional reply or reaction sent, regardless of the preview switch.
6. Keep module context, memories and lore out of the simple decision package. Add the inner-thought request (concurrent with the decision, same providers, structured stance and length), the simple-route path in `ThoughtsModule` with its ephemeral held-thought reservoir, and the held-thought line in later decision packages when `shadow` is off. Add the simple-decision and exclusion log events, including the thought fields. Update settings/help in all three languages and instance routing/rollback documentation.
7. Run structural/privacy regressions and local checks. Produce a concrete trial configuration (instance routing plus the channel's `decision-contract simple`) for the operator to apply.

Phase 2, after the Phase 1 exit:

8. Add the `message_origins` exchange columns with a SQLite and a PostgreSQL migration (passing `migrations:check`), update `MessageOriginRecord`, `SqliteMessageOriginStore`, `PostgresMessageOriginStore` and the session store, then implement stable exchange IDs recorded with delivery origin metadata, the confirmed-timestamp idle clock, delivery-extended anchors, epoch-bound reservations, idempotent accounting, the restart wait for linked exchanges and expiry-only capacity eviction. Remove the Phase 1 always-trial rule so the preview switch governs simple-contract channels.
9. Run the Phase 2 regressions, then the gated live step with a tight `per-exchange` limit. Raising limits and broader activation are separate decisions.

## Verification and rollout criteria

Phase 1 automated coverage must establish (the exchange-accounting item is Phase 2):

- Explicit requests preserve existing eligibility and bypass optional decision inference.
- Ineligible optional turns make no provider calls; only available actions can be admitted.
- Native configuration routes exclusively to `/decisions`; `DECISION_MODEL` with `chat_completions` routes to the dedicated model with the simple contract; absent dedicated configuration selects the reply LLM. A failed dedicated or native decision never invokes another provider.
- The reply-route decision call sends the decision reasoning effort; chat replies, summaries and other structured calls keep their existing efforts.
- Exactly one decision request is made per eligible turn, carrying action and emoji questions (or an app-bound `none` when React is unavailable). Reply/Ignore survive missing, refused, malformed, and out-of-list emoji answers in both adapters. React with any unusable emoji records a failed reaction selection. Invalid actions or corrupt envelopes always fail. No intent/evidence/contribution subquestions or minimum-of-many-confidence logic remain in simple mode.
- Contract resolution is channel, then guild, then instance; a legacy channel in a simple guild (and the reverse) behaves accordingly, and each log event names its contract.
- The binding rule preserves delayed linked follow-ups and grants open-exchange follow-up status to unlinked messages only inside the shared idle window after a bot message to this author, ending it when the bot answers someone else or this author addresses another human. It does not grant follow-up status from an old bot response alone. Explicit other-recipient exclusions take precedence. A disabled kind makes no call. The scheduler, `localAddressing` and the open-exchange rule read the same idle constant.
- Phase 1: the window boundary is inclusive at `exchangeIdleMs`; anchors from before process start never open an exchange; trial decisions and reactions never move the anchor; a simple-contract channel calls the model, logs the decision and sends no optional reply or reaction whether preview is on or off.
- Phase 2: successive delivered follow-ups refresh the anchor without changing exchange ID or clearing its counter; the configured per-exchange limit stops the sequence. Verify genuine idle resets, delayed callbacks, duplicate/multi-part deliveries, concurrent reservations and stale completions. Rolling limits survive idle epoch resets.
- Phase 2 migration: both drivers apply and roll forward cleanly, existing rows read as null exchange fields, and a null-exchange anchor suppresses a linked continuation.
- Phase 2 restart: exhaust an exchange, restart inside its idle window, then attempt a linked continuation. Verify `exchange_restart_wait` through the exact startup-plus-idle boundary, including when only an older ancestor is visible. After that boundary, a verified link may begin a new epoch; missing identity still fails. Pre-start anchors never qualify as open exchanges; genuinely new post-start exchanges remain eligible.
- Phase 2 capacity: fill all 512 entries with active, unreserved exchanges, including one at its limit. A new exchange receives `capacity`, and the exhausted exchange remains denied. Test expiry strictly beyond the idle boundary, reserved expired entries, recreation with a fresh epoch token, stale callbacks and preservation of channel rolling limits.
- Every model-called simple decision emits one info-level decision event with the fields above. Every skipped optional turn in a simple-contract channel emits one debug-level exclusion event; legacy channels emit none. Neither contains message content; privacy and access denials carry no source IDs; a skipped call is never logged as a model Ignore.
- Simple thresholds gate only native action probability and never modify legacy motivation thresholds. Mixed-mode channel pilots, per-kind inheritance, explicit zero overrides, and rollback preserve both threshold families.
- Current-message binding and source authorization survive malformed outputs, invented targets, revoked sources, expired leases, interleaved humans, delayed followups, and concurrent budget consumption.
- Brief replies can reach generation; generation can abstain; neither a Phase 1 trial nor preview ever delivers an optional turn. Emoji failure cannot become a text reply.
- Legacy mode and existing reaction-snapshot workflows retain their behavior.
- Inner thoughts: with `thoughts` enabled the simple turn makes one extra concurrent request, adds no latency to the decision, and a thought failure never changes the decision or blocks a reply. A thought is used only when the action is `reply` and `shadow` is off; it never admits, vetoes or changes a decision. A `reply` with stance `none` still generates. Held thoughts hold ids and enums only, are scoped by guild, channel, exchange branch and recipient, last no longer than `hold`, and are dropped on source deletion, access or context change, speaker change, and restart. A held thought is offered to the next decision only while its source is still authorized, and never authorizes output. Legacy turns and the legacy `thoughts` schema field and replay scripts are unchanged.
- The simple decision request contains none of: memories, guild knowledge, persona lore, persona drift, reply-chain summary, relation chains, alias candidates or `character:*` module context. Reply generation for the same turn still receives them.
- Callbacks, voice and message shape behave as before; a trial channel with callbacks enabled still sends callbacks.

Run typecheck, lint, focused adapter/contract tests, architecture/privacy checks, and relevant chat regressions. These prove wiring and constraints, not conversational accuracy.

The Phase 1 trial should look at unwanted replies, missed replies, wrong recipients, inappropriate reactions, failure rate, abstentions after generation, latency, and actual usage, from the logs. Decide whether those are acceptable before enabling live optional delivery; do not infer safety from accuracy alone or from complaint-only feedback. Native score calibration and LLM review are provider-specific.

The trial cannot show exchanges extended by delivered follow-ups. Phase 2's live step, with a tight `per-exchange` limit in the pilot channel, measures them: wrong-recipient replies late in an exchange, exchanges that should have ended, and how often the limit is hit. Raise the limit only after that review.

Rollback: set the channel or guild override back to `legacy` (immediate for new turns, no restart), or restore `PARTICIPATION_DECISION_CONTRACT=legacy` and the previous instance routing configuration for the whole instance. Preserve both threshold families: legacy resumes its original motivation values, and simple-action thresholds remain dormant for possible reactivation. Revalidate policy changes before delivery and suppress stale in-flight optional proposals rather than reinterpret them under another contract. Log events carry contract/provider revision so rollback does not mix incompatible metrics.

## Deferred work

Free-text inner thoughts on LLM routes, timer-driven re-evaluation of held thoughts (no send without a new message today), Laya integration, a lean decision package for legacy mode (measure it first, since it changes validated legacy behavior), automatic runtime provider failover, per-guild emoji lists (the emoji question already takes the allowlist as input, so this is a settings change later), simultaneous reply-and-react, rewriting reaction-snapshot decisions, and broad model benchmarking are outside this first implementation. Add them only when the simple native/LLM path and its trial run are working.
