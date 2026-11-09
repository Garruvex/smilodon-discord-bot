# Phase 5 evaluation and release readiness

Status: offline policy comparison recorded on 2026-10-20; live evaluation and rollout are not complete. Phase 4 is implemented in checkpoint `41e23a8c`. This is a release-readiness record, not approval to enable production behavior.

## Evidence available

| Gate | Local result | Practical limit |
| --- | --- | --- |
| Full regression | 4,679 passed / 7 skipped | Seven environment-dependent skips remain; this is not a live service result. |
| Type, changed-file lint, metadata, migration, whitespace | Passed | Repository-wide lint has the existing unrelated failures documented in Phase 3. |
| Seven-interaction guarded context integration | Passing Phase 3/4 tests | Providers and Discord are controlled test doubles. This establishes source/decision/delivery contracts for tested cases, not conversational quality. |
| Access revocation, source edits/deletion/forgetting, bounded stalls, retry/backoff, partial delivery, stale UI, shutdown | Passing regression cases | These faults do not cover every transport/platform failure. Nonce enforcement has Discord's documented bounded window. |
| Recorded continuation/spontaneous policy comparison | **38/38** expected labels match; hypothetical former policy matches **23/38** on the same fixtures | Curated regression cases with recorded decisions; not a random sample, model benchmark, or claim of production improvement. |
| Real-provider synthetic evaluation | Not run | The plan requires at least 200 cases, reported by provider/language/interaction, including fallback and failure latency. |
| Live shadow comparison | Not run | Offline baseline/proposed policy comparison is not production shadow observation. |
| Live Discord pilot and rollback | Not run | No server/channel was selected or enabled by this work. |

The [saved replay result](evaluation/phase-5-policy-replay-2026-10-20.json) records the implementation revision, fixture SHA-256, client date/timezone, synthetic/hypothetical markers, and explicit zero network calls/Discord sends. Its `calls` fields count in-process recorded-decision callbacks. Its latency fields measure local replay work, not provider or Discord latency. No production conversation or private screenshot/log text is included.

Reproduce the policy comparison from the repository root:

```powershell
npm.cmd run eval:character-replay -- --participation-fixture tests/fixtures/participation-replay.json --output policy-review.json
```

This command's participation-fixture branch performs no provider calls or Discord sends. The general conversation replay branch is a direct-turn model tool; running it alone would not establish guarded seven-interaction parity. Real-provider evaluation must exercise the intended source builder, trigger, authorization, and decision paths as well as response text.

## Live evaluation and pilot sequence

1. Identify the exact test guild and channel/thread, the build revision to run, the providers/models, and the approved synthetic fixture/call budget. Use fictional participants and no production chat content. Confirm that the live harness actually selects guarded context and each requested interaction mode.
2. Evaluate at least 200 cases across all seven interactions and English, Traditional Chinese, and Japanese. Include pending versus completed requests, bare pings, long gaps, ambiguous interleaving, explicit-other recipients, stale facts, missing evidence, role changes, derived-source invalidation, decision failures/fallback, and partial/unknown delivery. Keep deterministic access/grounding checks distinct from human labels for relevance, tone, attribution, timing, and appropriate silence.
3. Report valid decisions before/after fallback, latency/cost, underfilled context, omission causes, duplicate/incorrect-recipient outputs, and valid silence separately from failure. The plan's 99% valid-decision target is an unmeasured release gate, not a result of the 38-case replay. Privacy, recipient, or duplicate-delivery failures stop expansion.
4. Compare shadow behavior on approved inputs without changing read scope. Confirm actual bot/viewer permissions and message-origin/proof behavior against Discord. Verify explain-message access using real author/admin/non-admin accounts. Review provider errors and 429 caller metadata without capturing raw protected content.
5. Activate only the explicitly chosen pilot scope after review; then evaluate continuations and spontaneous behavior separately before wider use. Do not push or deploy this branch merely because offline checks pass.

`character.context.retrievalMode` is a guild-level setting. A one-channel pilot must account for its effects on other channels; prefer an isolated evaluation guild or an explicitly reviewed/narrowed profile. A channel context override alone is not a per-channel retrieval-mode switch. Keep the existing `legacy` default until a scoped activation is chosen. The new guarded text mode deliberately excludes memory, summaries, learned state, images and tools; assess those capability differences before enabling it.

For a privacy or invalid-context incident, contain the affected chat/history feature or read scope. Switching to legacy restores the previous path and its documented gaps, so it is not an equivalent guarded privacy rollback. Local settings rollback preserves the message target and existing data; production rollback, late-send handling, and observed recovery still require a live check.

No real-provider, live-shadow, deployed-SHA, or pilot metrics have been fabricated. The next live step needs the target server/channel requested in the chat; no live settings have been changed while that target is unspecified. The universal context gateway and excluded source migrations remain separate from this rollout.
