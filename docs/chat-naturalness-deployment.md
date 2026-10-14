# Deploying the chat naturalness changes

Prepared 2026-10-14. Deployment is manual on your server. No running bot, server configuration, Discord commands, or production records were changed from this workstation.

## Before starting the new version

1. Stop the instance and back up its database, guild configuration, and runtime data. Keep the previous release available.
2. Shared personal memory now defaults **off** (`chat.sharedMemoryEnabled: false`) for new and existing guilds. Review `chat.channelMemoryModes` for every private/restricted channel **and thread** before activating `/settings-memory sharing enabled:true`. Unlisted IDs use `shared`; permission restrictions and parent-channel memory modes are not inferred. Existing private facts stay private. Disabling activation later does not privatize already shared facts.
3. Keep continuation and spontaneous participation off initially (their defaults). Existing ambient name triggers retain their separate controls. Review access roles, chatbot master enablement, and existing chat feature/channel restrictions.
4. Install dependencies and validate the intended instance. On the server, substitute your actual instance name:

```sh
npm ci
npm run instance:config:validate -- INSTANCE_NAME
npm run typecheck
npm run migrations:check
npm run build
npm run instance:db:migrate -- INSTANCE_NAME
npm run instance:deploy -- INSTANCE_NAME
```

Use your existing service/container start procedure after the migration and command refresh. For installations using the active environment rather than an instance wrapper, the corresponding commands are `db:migrate:active` and `deploy:commands`. Do not run both sets against different databases accidentally.

Migrations add origin records, memory source evidence, original extraction messages, forgetting cutoffs, and bounded conversation episodes. Old private facts keep their audience. Old session/extraction records without verifiable human source evidence cannot create new shared facts. Pending optional replies are never replayed after restart.

## First server checks

- In an allowed shared channel, Bob says he likes apples. Alice asks about Bob after recent history is no longer available and from another allowed shared channel. Bob can list, correct, and forget the fact; Alice cannot remove Bob's personal fact.
- Repeat in an isolated channel. Another channel must not recall that fact. Session-only and disabled channels must not retain durable facts.
- Try a changed nickname and two users with the same nickname. Account IDs remain distinct; ambiguous names must not silently select one account.
- Try a substantive direct question, a bare ping, repeated pings, a functional tool request, and a reply to a link-fix/tool output. Functional interactions must not turn into social follow-ups or memory evidence.
- Test D&D channels and their threads, including an already scheduled reaction follow-up. No social reply or reactor ping should appear there.
- Restart once: recent allowed episode context may survive within its retention window; stale pending outputs must not replay.

Naturalness still needs human review with your real model and conversations. Note usefulness, unwanted interruptions, missed direct answers, attribution, response time, and provider cost.

## Optional participation pilot

The new controls are under `/settings-participation` and the admin panel:

- `controls`: continuation, spontaneous, activity, bare-pings, shadow.
- `spontaneous-channels`: explicit allowed channels. Enabling spontaneous alone is insufficient.
- `participation-channel`: per-channel continuation/spontaneous/reaction/activity overrides and reset.
- `activity-limits` and `activity-reset`: advanced limits and restoration of preset inheritance.
- `resources`: per-guild concurrency and optional-turn admission. Defaults are four concurrent turns and 100 optional turns per ten minutes. Direct turns do not consume this optional budget, and accepted tool rounds are never aborted by it.

Start with shadow mode and one explicitly allowed channel. Shadow decisions produce metadata logs, with no delivery or tool/memory side effects. Shadow applies to chat turns, so expect normal chat replies to be suppressed while it is enabled. Then disable shadow for a limited live pilot. Choose `quiet` first if uncertain. Presets constrain optional activity, not meaningful direct answers:

| Preset | Evaluation spacing | Text spacing / per 10 min | Reaction spacing / per 10 min |
| --- | --- | --- | --- |
| quiet | 30 s | 120 s / 1 | 40 s / 3 |
| balanced | 25 s | 90 s / 3 | 30 s / 5 |
| lively | 20 s | 60 s / 3 | 20 s / 5 |

These are upper limits, not engagement targets. Disable the new switches to stop optional participation. Eligibility and configuration are rechecked before execution and delivery.

## Optional historical private-memory backfill

Backfill is separate from deployment. It requires a reviewed manifest and original human messages still accessible to the bot. Current channel visibility alone does not prove historical visibility. Missing, bot-authored, mismatched, forgotten, or conflicting evidence stays at its existing audience.

Create a JSON manifest using real IDs (the values below are illustrative):

```json
{
  "adminReviewedHistoricalVisibility": true,
  "entries": [{
    "guildId": "123456789012345678",
    "memoryId": "00000000-0000-4000-8000-000000000001",
    "sourceMessageId": "123456789012345679",
    "sourceChannelId": "123456789012345680",
    "historicalMode": "shared",
    "sourceQuote": "I like apples",
    "approved": true
  }]
}
```

After migrations and explicit sharing activation, run the default read-only dry run:

```sh
npm run instance:backfill-public-memories -- INSTANCE_NAME --manifest reviewed.json
```

Review the report, keep a database backup, and stop the bot for maintenance before applying the same manifest:

```sh
npm run instance:backfill-public-memories -- INSTANCE_NAME --manifest reviewed.json --apply
```

The script fetches Discord evidence but sends no messages. Apply changes only the reviewed eligible rows; isolated historical sources remain isolated. Repeating an applied manifest is safe. There is no blanket private-to-public migration. If recovery is needed, stop the instance and restore the matching database/configuration backup with the previous release.

## Verification limits

The pre-review implementation passed 4,144 tests. The deployment-fix revision adds activation, consent, forgetting, admission, and freshness regression checks; see the latest handoff for final counts. PostgreSQL-dependent suites require a test server. Whole-repository lint has existing activity JavaScript/global-variable failures, and translation coverage has existing campaign gaps; these unrelated checks are not reported as passing.

Local tests cover deterministic policy, scheduling, context, and SQLite lifecycle behavior. Live Discord/provider naturalness and PostgreSQL integration require server validation. Restricted full-prompt capture and editing uploaded examples into an action-aware file format remain separate follow-up work; current diagnostics use compact metadata and application prompts contain action examples. Quote-card layout and `quote_message` were outside this implementation.
