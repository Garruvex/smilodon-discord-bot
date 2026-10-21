# Contextual participation implementation and release evidence

Status: local engineering implemented behind `contextual_v1`; production activation and a scoped live Discord pilot have not occurred. The source-migration track remains separate. See the [implementation plan](chat-contextual-participation-plan-2026-10-21.md).

## Final local acceptance after the common-flow audit

The [alignment ledger](chat-plan-alignment-2026-10-21.md) records the full requirement-by-requirement closure. The service now resolves one effective turn plan, fails closed on missing/mismatched guarded prerequisites and authorizes immutable effect snapshots consumed by all three Discord adapters. Guarded reaction turns have typed preflight. Same-speaker exchange links and independent cross-speaker bot references replace citation-only grounding. Unwired refresh/count-first paths, the test-only decision wrapper, obsolete hook authority and empty addressing module have been retired. Persisted addressing controls remain read-compatible but are no longer offered as active settings.

Twenty-one adapter/strategy combinations exercise all seven interactions through real dispatch, access, runtime, scheduling, delivery support and SQLite, with additional reaction/failure/revocation/shadow regressions. Architecture tests protect runner/permit ownership. Legacy context and legacy decisions inside guarded context remain explicit compatibility strategies. Legacy reactions use a validated transport snapshot plus their existing generation/action contract; guarded reactions use typed semantic preflight. These differences are documented rather than hidden behind optional port presence.

The fixture is now revision 3: a different speaker's bare selection cannot inherit the earlier person's bot exchange or be reclassified as an open group invitation. Wire revision 4 adds application-bound exchange links. Prompt revision 2 clarifies that independent bot corrections and repair-response questions require acknowledgment/clarification without claiming an unverified repair. Policy revision 3 includes the stronger link/reaction rules.

Acceptance thresholds were declared before the new results: at least 200 cases; at least 99% valid and 95% controlled expected-meaning checks; zero disallowed text replies; at most one required-reply miss; decision p95 at most 12 seconds. The CLI now fails when any of these preflight gates fails, including semantic/response failures despite valid schemas. These thresholds do not establish a production cost limit or full-turn latency.

| Synthetic run | Valid / expected meaning | Unwanted text / required misses | Decision p95 | Result |
| --- | --- | --- | --- | --- |
| `contextual-live-replay-v4-policy3-2026-10-21.json` (utility, initial prompt) | 178/216 / 115/216 | 11 / 33 | 8.221 s | Failed |
| `contextual-live-replay-v4-reply-reference-2026-10-21.json` (reply route, initial prompt) | 216/216 / 214/216 | 0 / 3 | 6.758 s | Failed required replies |
| `contextual-live-replay-v4-prompt2-reply-2026-10-21.json` | 216/216 / 216/216 | 0 / 0 | 5.952 s | Passed preflight gates |
| `contextual-live-replay-v4-final-routing-2026-10-21.json` (final default selector) | 216/216 / 216/216 | 0 / 0 | 6.189 s | Passed preflight gates |

The final default run used Pinecone's existing structured reply route, `gpt-5.6-luna` with medium reasoning. It admitted all 72 required substantive replies; all 216 model attempts were measured and valid on primary, with no fallback recovery needed. It recorded 277,884 input tokens (277,236 cached), 58,301 output tokens (38,917 reasoning, included within output). Token counts are provider-reported; monetary cost requires the operator's applicable rates. Cancelled/unreported requests may have missing usage. These are controlled synthetic variations, not 216 independent human conversations; labels do not measure generated-answer quality.

Provider routing revision 2 is shared between bootstrap/runtime and the replay: an explicit `DECISION_MODEL` remains primary; otherwise contextual interpretation uses the reply provider's structured route. Its configured summary-model override is honored and reported. A dedicated primary may fall back to that reply route within the existing budget. A failed reply route does not silently downgrade to the generic utility. If no reply structured capability exists, utility selection is explicit and needs its own acceptance run. Legacy decision routing remains unchanged. This intentional opt-in behavior change follows the failed utility and passing reply-route measurements; no instance environment or production guild setting was edited.

`--provider-role decision` (default) now evaluates the actual production contextual selector; `--provider-role reply` and `--provider-role utility` are explicit comparisons. Historical reports without routing revision 2 retain their historical provider selection. The older character/policy replay tools now label their legacy scope and cannot be substituted for contextual acceptance.

Remaining release gates: independent semantic review; an explicitly selected deployed shadow/live channel with deployed SHA; full-turn p50/p95 including coalescing and actual generation/delivery; a cost budget agreed before pilot results; and actual Discord delivery/notification observation. Memory, derived summaries, learned state, images and tools remain excluded from guarded text until the separate source migration passes. No production deployment, activation or Discord send was performed.

## Implemented checkpoints

| Commit | Checkpoint |
| --- | --- |
| `52f8666d` | Strict contextual decision contract; application-owned fixed destinations; constrained selectable targets; valid abstention; explicit flow setting |
| `34bf7bf5` | Neutral eligible candidates; finite pause/coalescing/lifetime; candidate lifecycle diagnostics |
| `0c84518c` | Contextual classification before participation policy, thresholds, output budgets and reservations; contextual reaction policy |
| `023320b5` | Authorized ancestry/reference/exchange anchors in the decision projection; coverage diagnostics |
| `7651874e` | End-to-end work cancellation, generation reserve, transport abort propagation, bounded waiting and explanations |
| `f71d964c` | Real preflight policy measurement with synthetic authorized leases; targeted replay filters |
| `d4433fd4` | Post-context referent resolution; safe proposal labels and wire-revision diagnostics |
| `ea120c50` | Known-recipient evidence and separate policy for grounded substantive requests |
| `6dbcd37b` | Carry requested answer/clarification intent into the generator handoff |

The release/evaluation checkpoint additionally provides synthetic replay tooling, measured opt-in timeout tuning, per-channel/thread flow and shadow overrides, cross-submission deduplication, candidate-to-turn correlation, safe target-failure subreasons, and short evidence keys mapped back to authorized event IDs. Keys are references, never new read permissions.

## Local verification

The suites include all seven interaction modes in both legacy and contextual settings, isolated short messages, continuous fragments, continuation-only scope, recipient correction, social reactions, substantive questions, privacy rejection, cold/older exchange evidence, invalid targets, candidate expiry, duplicate sources, stalled state/generation dependencies, abort propagation, queue recovery, and late-send prevention. Final verification counts are recorded in the implementation plan after the release checkpoint.

Latest local result after the grounded-reply policy correction: **4,796 passed / 7 skipped**. Typecheck, production TypeScript compilation, changed-file lint, settings metadata/registry validation and whitespace checks passed.

Existing source/provenance gates, nonce/partial-send handling and restricted-role precedence remain in effect. The new flow defaults off. The thirty-second work budget starts when the chat turn starts; coalescing and a cooldown can add visible waiting before it. A dispatched Discord send cannot be atomically recalled, so timeout is not authorization to resend.

## Real-provider evidence and limits

Only synthetic conversations were sent to the configured local Pinecone provider. No Discord messages were sent, no production conversations were exported, and no live settings were changed. The configured structured utility in these runs was `gpt-5-nano`, low reasoning, through the Responses transport; this differs from the main reply model.

| Artifact | Result | Interpretation |
| --- | --- | --- |
| `contextual-live-smoke-2026-10-21.json` | 0/3 valid at six seconds | Initial decision cap was too short for these requests |
| `contextual-live-latency-2026-10-21.json` | 3/3 valid; p95 6.992 s | Simplified-prompt latency probe; not a quality benchmark |
| `contextual-live-full-prompt-latency-2026-10-21.json` | 3/3 valid; p95 8.739 s | Exact full-prompt probe supporting a larger opt-in attempt allowance |
| `contextual-live-replay-2026-10-21.json` | 210/216 valid (97.22%); 93/216 original controlled checks; p95 9.869 s | Failed the 99% validity gate; semantic failures prompted grounding changes |
| `contextual-live-prompt-smoke-2026-10-21.json` | 8/8 valid; 4/8 controlled checks | Destination/intent clarification alone was insufficient |
| `contextual-live-grounding-smoke-2026-10-21.json` | 8/8 valid; 6/8 controlled checks | Added explicit exchange relationships and shorter evidence keys; still not release acceptance |
| `contextual-live-replay-v2-2026-10-21.json` | 214/216 valid (99.07%); 155/216 controlled checks; p50 5.494 s / p95 8.399 s | Validity target met; interpretation/action review remains open |

The current opt-in attempt cap is twelve seconds, retaining twelve seconds total model time. Decision work still leaves ten seconds for remaining generation/validation/delivery and skips attempts with less than six useful seconds. Legacy attempts retain the six-second cap. This was measured tuning; no production model or credential setting changed.

The matrix has 216 controlled variations: eight situations, three languages, three time gaps, and three speaker contexts. These are not 216 independently authored human conversations. Fixture revision 2 corrects an initial expectation that treated an intervening speaker as automatically breaking a same-person exchange, contrary to the design. Earlier artifacts are historical revision-1 results and are not directly comparable with revision-2 controlled-check totals. The validity rate remains comparable. Wire revision 2 uses short evidence keys; runtime validation resolves them only to supplied authorized sources.

The revision-2 full replay is recorded separately as `contextual-live-replay-v2-2026-10-21.json`. Raw model relationship/action proposals are scored; deterministic privacy, recipient-correction, missing-proof and action-policy guards may subsequently suppress a proposal. Therefore these scores are neither a measured Discord false-interruption rate nor end-to-end answer quality. They must not be represented as successful delivery or a passed live pilot. Token/cost measurement is unavailable in this runner.

Revision-2 review: explicit human-recipient and open-group situations matched all 27 controlled checks each; correction cases matched 24/27 and repair questions 26/27. Ambiguous isolated questions remain weak (2/27), and gratitude/cross-speaker cases need review. The two invalid decisions were timeouts. The application separately rejects unsupported follow-ups and known explicit recipient corrections, including the wording represented in the corpus. An ambiguous message wrongly labelled as a group contribution is still a possible false interruption; the current evidence does not justify broad activation. Keep the new flow disabled outside an authorized shadow pilot while these semantic issues are assessed.

## Follow-up evaluation and policy corrections

The replay now also runs the real preflight decision engine against an in-memory synthetic authorization lease. Both participation modes and action budgets are available, isolating policy from scheduling, generation and Discord delivery. Per-case output distinguishes the raw proposal from the policy action, status and reason. Text-policy violations and required substantive-reply misses are separate counters; a provider failure remains a failure even when its final action is silent.

The targeted wire-revision-2 baseline `contextual-live-unknown-policy-v2-2026-10-21.json` recorded 27/27 valid decisions, 4/27 expected raw-label checks and **1/27 disallowed text replies after preflight policy**. These synthetic counts are not a production interruption rate. Targeted runs cannot satisfy the 200-case release gate. Use `--scenario unknown` or `--language en` to select a subset before applying `--limit`.

Wire revision 3 adds a required `referent` enum: `self_contained`, `context_linked`, or `unresolved`. The application suppresses optional output for unresolved referents and rejects claimed context links without an earlier authorized citation or the current-event citation. This happens after context assembly; explicit requests keep their existing response obligation, and message length or age does not determine admission. The prompt also separates a different participant's brief answer/thanks from an independent reference to the bot's behavior. The field remains a model claim: a wrong `self_contained` label or an unrelated earlier citation is not a semantic proof.

The targeted revision-3 artifact `contextual-live-unknown-policy-v3-2026-10-21.json` recorded 26/27 valid decisions, 23/27 raw-label checks and **zero disallowed text replies after policy**. One response violated the contribution contract; it is a failure, not successful abstention. These are single stochastic runs with unchanged fixture revision 2, not a statistical guarantee or a passed release gate.

The first full revision-3 replay, `contextual-live-replay-v3-2026-10-21.json`, recorded **216/216 valid**, **168/216 raw-label checks**, p50 **5.895 s** / p95 **9.702 s**, and zero disallowed preflight text replies under the corpus's conservative text policy. It also missed **59 of 72 expected substantive replies**. This is a failed responsiveness result despite passing validity and avoiding unwanted text. Required replies are correction/repair cases and same-person/interleaved answers; silence and failed decisions both count as misses there.

That policy measurement exposed two application defects. First, the legacy unknown-name heuristic classified ordinary comma-prefixed clauses as another recipient, suppressing all nine Traditional Chinese correction cases. Contextual hard-recipient rejection now requires known names/aliases or explicit mention/reply metadata; the model still resolves unknown names using supplied context. Known ambiguous aliases remain guarded. Second, grounded answer/clarification turns were subjected to unsolicited-contribution novelty, label and motivation requirements. These turns now retain recipient, evidence, confidence, opening, action-budget and delivery checks while omitting the unsolicited-contribution test. Final generation must preserve answer/clarification intent. Group and social contributions keep their existing quality tests. Neither fix changes legacy admission or reduces confidence thresholds.

Replay reports from this correction onward identify `policyRevision: 2`. Earlier policy reports used revision 1 implicitly; the wire remains revision 3. A fresh provider run is a stochastic comparison, not a replay of identical saved proposals.

The generator handoff also distinguishes requested answers from unsolicited contributions. It asks for an answer/clarification to the grounded follow-up, permits a brief requested confirmation and forbids claiming an unverified repair/status. Integration tests inspect that actual handoff and ensure social-only generated intent cannot satisfy the substantive request. The synthetic provider replay measures preflight only; it does not establish generated-answer or Discord-delivery quality.

Final wire-3/policy-2 evidence is `contextual-live-replay-v3-policy2-2026-10-21.json`: **215/216 valid (99.54%)**, **170/216 raw-label checks (78.70%)**, p50 **6.202 s** / p95 **8.851 s**. The validity gate passes. The one invalid response violated the contribution contract. Expected substantive-reply misses were **48/72**, compared with 59/72 in the separate policy-1 run; this still means only 24/72 required replies were admitted and is not acceptable responsiveness. Most remaining required misses were low recipient confidence (22) or unresolved recipient evidence (17); do not lower confidence thresholds merely to increase replies.

| Required situation | Cases | Policy-2 admitted replies | Misses |
| --- | --- | --- | --- |
| Same-person/interleaved answer | 18 | 9 | 9 |
| Contextual correction | 27 | 3 | 24 |
| Repair-status question | 27 | 12 | 15 |

The corpus text-policy counter remained zero, but manual audit found **two accepted wrong cross-speaker followups** among the nine different-speaker answer cases, as in the earlier policy-1 run. Thus neither responsiveness nor complete recipient safety passes. Keep activation unchanged. Next work should distinguish semantic exchange links from mere citation presence, record safe confidence/evidence diagnostics for calibration, and tighten the cross-speaker negative cases under an explicit fixture/scoring revision. Independent review and a scoped pilot remain subsequent gates. The reported latency is decision latency only, not an end-to-end response guarantee.

Fixture revision 2's text-policy counter is narrower than complete recipient accuracy: a different speaker's answer case allows group/unclear interpretations and does not forbid all text. A wrong followup to that speaker can therefore escape the text-policy counter even while failing the raw relationship check. Review accepted cross-speaker followups separately; zero text-policy violations must not be described as zero false interruptions. Tightening that fixture requires a labelled fixture/scoring revision, not silently changing historical totals.

`model.decision.attempt` identifies the wire revision. The new `chat.decision.proposed` event records only controlled relationship/referent/intent/action labels and the evidence count. Compare it with `chat.decision.resolved` to distinguish model interpretation from policy suppression. Message text, generated contribution text and model reasoning are excluded from this event.

## Reproduction

`eval:contextual` runs TypeScript source and requires development dependencies, including `tsx`. A server host using only Docker may have no host dependencies at all; production-only installs and the runtime image intentionally omit `tsx`. A `tsx: not found` failure occurs before the replay or provider requests start.

For the existing Docker deployment, run the compiled replay inside the selected bot container and write to a writable location. This starts only the evaluation script; it does not start another bot, run migrations or restart the service:

```sh
docker compose exec -T bot-pinecone node dist/scripts/replay-contextual-participation.js --live --instance pinecone --limit 216 --concurrency 4 --output /tmp/contextual-replay.json
docker compose cp bot-pinecone:/tmp/contextual-replay.json ./contextual-replay.json
```

For inventory only in that same container:

```sh
docker compose exec -T bot-pinecone node dist/scripts/replay-contextual-participation.js --output /tmp/contextual-replay-inventory.json
docker compose cp bot-pinecone:/tmp/contextual-replay-inventory.json ./contextual-replay-inventory.json
```

The container must contain a build with this script. For a host checkout that already has compiled `dist/` and runtime dependencies, `npm run eval:contextual:built -- ...` runs the same compiled entry point without `tsx`; keep the build aligned with the checkout. The direct `node dist/scripts/replay-contextual-participation.js ...` form also works with builds made before the named npm command was added. For source-based evaluation in a development checkout, install the locked development dependencies with `npm ci --include=dev` before using the commands below. Report output directories are created when absent.

Inventory only, with no API calls:

```text
npm run eval:contextual -- --output docs/contextual-replay-inventory-2026-10-21.json
```

Check an explicitly selected instance's credential presence without displaying secret values:

```text
npm run eval:contextual -- --check-config --instance pinecone
```

Synthetic live decision replay (uses the selected instance's configured provider):

```text
npm run eval:contextual -- --live --instance pinecone --limit 216 --concurrency 4 --output contextual-replay.json
```

`--probe-timeout-ms` is an explicitly labelled latency experiment, limited to three cases and at most twenty seconds per request. Its results cannot meet the release gate. The runner neither connects to Discord nor initializes production persistence. It writes only safe labels, timings and failure categories. A full live run below 99% validity exits nonzero. Independent semantic review, interruption/cost thresholds, and live pilot approval are additional requirements even if validity passes.

## Scoped rollout after acceptance

1. Review the real-provider report and unresolved cases. Do not activate broadly while semantic quality or reliability remains inadequate.
2. Build/deploy a verified commit using `npm run stack:up` in the server checkout. Verify `buildVersion` in startup logs; deployment has not been performed here.
3. Verify the existing channel history, exact observation scope, author permissions and memory mode. Enable eligible-count context using `/settings-character context` with `enabled:true` and `retrieval-mode:eligible_count`. This can change available capabilities in already-configured channels; review the policy report before activation.
4. Keep the global flow at `legacy`. Use `/settings-participation participation-channel` on one explicit channel with `flow-version:contextual_v1`, `shadow:true`, and the desired continuation/group controls. A thread must be selected explicitly through `thread-scope` with its ID; flow and shadow flags are supported there without granting parent-derived scope.
5. Inspect `/settings-participation policy channel:<target>` and authorized explain-message records. Candidate IDs connect buffer membership to a submitted turn. Optional/name-address/reaction adapter shadow behavior is retained; direct mention/reply responses retain their existing behavior. Shadow evaluation does not duplicate optional visible replies.
6. After an authorized scoped pilot decision, set only that channel/thread's `shadow:false`. Review short untagged follow-ups, bare pings after pending questions, long gaps, multiple speakers, reactions and failure explanations. Record intent accuracy and false interruptions separately from reply count.
7. Roll back that channel/thread to `flow-version:legacy` or disable its optional participation. Configuration changes invalidate old candidate fingerprints. Do not restore unverified legacy derived context or replay old pending messages.

## Release gates still requiring evidence

- At least 99% valid decisions over at least 200 real-provider cases on the final wire/prompt version.
- Independent review of contextual meaning and conservative action policy, including unresolved negative/ambiguous cases.
- Explicit interruption and cost thresholds before evaluating the pilot.
- Full-turn latency and delivery behavior against the actual deployed reply provider and Discord transport.
- Scoped production shadow and live pilot, with deployed SHA and policy snapshot.
- Separate migration/acceptance for memories, summaries, learned state, images and tools. These remain excluded from guarded text context.
