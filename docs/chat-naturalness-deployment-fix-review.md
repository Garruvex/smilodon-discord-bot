# Deployment fix review — 2026-10-14

The review found real activation, consent, resource, and compatibility gaps. This revision addresses them on `codex/chat-naturalness-deployment-fixes`; nothing has been deployed.

| Finding | Result |
| --- | --- |
| Automatic sharing | `chat.sharedMemoryEnabled` defaults false. New self-facts remain private until explicit guild activation, even when the model asks for guild audience. Existing private facts stay private. Panel/slash activation and all three languages are included. |
| Incomplete disclosure | Memory inventory names its visibility; forget-all describes shared/private facts, derived summaries, queued learning, and stored recent context. User and deployment guides document activation and consent. |
| Whole-bot caps | Concurrency and optional-turn admission are configurable per guild. Direct turns bypass optional admission; accepted tool rounds do not hit an application call-budget exception. Provider usage logging remains. |
| Passive messages without consent | Observer exits before eligibility/database work when channel history is off; the conversation service does not load/merge episodes without the opt-in. Explicit replies and configured background scans retain their separate contracts. |
| Forget-all leaves episodes | Forget-all clears in-process and persisted user messages/reply branches plus recent sessions. It waits for background writes and invalidates in-flight context. Notes preferences are preserved by the production session-clear operation. Discord messages themselves are not deleted. |
| Busy channels suppress named replies | Version changes invalidate continuation/spontaneous work only. Named, reaction, and bare-ping paths retain expiry/access checks but survive unrelated traffic. |
| Legacy/deleted reply targets | Direct pings can proceed with missing or unknown-origin targets; verified utility/game outputs remain excluded. Optional work still fails closed on unresolved ancestry. |
| Per-message history fetches | Default-off observation avoids all eligibility work. Opted-in passive observation uses cached messages only, at most three hops, with bounded short-lived origin lookup caching. It makes no Discord history REST calls. |
| Evidence exceeds budget / N+1 reads | A single bounded source query replaces per-memory reads. The final conservative budget includes quoted/escaped evidence and observed names; an adversarial quote regression checks the actual rendered memory sections. |
| Old queued opportunity wins | The newest pending optional candidate replaces and resolves the previous candidate. |
| Alias scans/substrings | Indexed `(guild_id, alias)` rows join authorized active memories. Queries use bounded exact tokens; two-character Han labels must be standalone, avoiding substring account resolution. |
| Many unreleased migrations | One fresh migration per backend, regenerated from the last released schema snapshot. Previously released migrations are unchanged. |
| Stale comments | Memory lookup comments describe subject filtering and bounded results across authorized audiences. |

## Review and PR boundaries

The checkout is moved off main. This document is the proposed extraction order for separately mergeable PRs:

1. Quick wins: game guards, reaction notifications, reply references, capability alignment.
2. Origins and eligibility: persisted origin contract, functional-output exclusion, explicit-reply compatibility and consent-aware observation.
3. Memory lifecycle: default-off activation, disclosure, scoped ownership/correction/forgetting, indexed aliases, evidence budgeting, reviewed backfill.
4. Scheduling and participation: per-guild admission, fresh candidate replacement, consent-aware episodes, forgetting, opt-in triggers and settings.

**These PRs have not been extracted or published.** The current implementation spans shared files and schema, so merely dividing file lists into four commits would not produce independently buildable PRs. The branch is a tested integration checkpoint; each extracted PR still needs its own dependency closure, migration delta, and checks. Do not treat this list as completed PR separation.

## Validation

Final integration verification: 312 test files passed, 4,159 tests passed, and five PostgreSQL-dependent suites/tests skipped without a test server. Typecheck, changed-file lint, production build and migration normalization passed. PostgreSQL integration remains unverified locally. Whole-repository activity lint and campaign translation coverage have pre-existing failures.
