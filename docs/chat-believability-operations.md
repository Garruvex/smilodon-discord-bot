# Character modules: operation and pilot

The implementation plan is [chat-believability-plan-2026-10-14.md](chat-believability-plan-2026-10-14.md). Modules and expanded conversation context default off. This guide describes a staged human review; automated tests cannot establish whether the character feels believable.

## Install and configure

Apply the normal database migrations before starting the new build. SQLite migration 0013 and PostgreSQL migration 0022 add nullable memory module ownership, separate memory identities and conversation-window retention. Ordinary facts remain ordinary facts. Use the normal database backup and deployment procedure.

The existing utility-provider chain performs reflections, canon extraction, fictional sketches and voice repair. An optional OpenAI-compatible structured social provider handles addressing, motivation, topic boundaries, reply targets and candidate speech in one request:

```dotenv
DECISION_MODEL=your-decision-model
DECISION_BASE_URL=https://your-provider.example/v1
DECISION_API_KEY=your-key
```

The provider uses ordinary `/chat/completions` with structured JSON output. It is economical only if you choose a suitable small model; it is not a specialized native decision endpoint. Candidate generation and self-rating happen in the same call, and the 0.5/0.7 heuristics are uncalibrated. Keep them in shadow mode until humans label the results. Direct/name turns skip the call unless context boundaries are explicitly live. Omitted credentials/base URL use the instance's `OPENAI_*` values. A local endpoint may accept an empty key. Without `DECISION_MODEL`, decisions use the utility chain; invalid or failed decisions fall back safely. These values belong in each instance's environment file and are not inherited from the root environment. Never place credentials in guild YAML.

Deploy slash commands through the existing command deployment procedure to expose `/settings-character` and `/character-eval`. The same registry supplies the admin panel, English, Traditional Chinese and Japanese descriptions, validation and access policy.

## Enable a small pilot

1. Choose one disclosed chatbot channel and a fictional persona. If using a real person's persona or examples, obtain their consent first. Explain that enabled channel history includes other participants' messages in provider requests.
2. Enable only `character.evaluation` first. Run interview probes and collect baseline flags. Evaluation can work with the character master switch off.
3. Enable the character master and individual modules through `/settings-character`. Start with voice and natural recall; then canon with `freeze:true` while reviewing its ledger. Relationship impressions require memory sharing. `/settings-character status channel:<channel>` explains module dependencies.
4. Enable conversation context separately. Defaults are 15 minutes, a 10-minute silence boundary, 40 messages, a 12,000-character budget and 10 decision messages. The upper window is 20 minutes/48 persisted events. Running summaries default off. Memory exclusions, utility/D&D ownership and member access still control live delivery.
5. Keep addressing, thoughts and context boundary decisions in shadow mode until humans label their choices. Thoughts additionally require addressing, a decision/utility provider and participation. Enable live behavior only after reviewing mistaken interruptions and wrong-person responses.
6. Turn on continuation only with context. It uses 10 bot replies per exchange and 30 per channel per ten minutes by default; two minutes of inactivity ends an exchange. `/settings-participation continuation-limits` adjusts the caps. Spontaneous replies retain stricter cooldowns. Both share guild admission and concurrency.
7. Consider callbacks, split messages, mood and fictional daily sketches separately. Daily sketches require canon and explicit acceptance of fictional daily life. Split messages default to one with no added delay.

Each module stores only its applicable controls. Voice defaults to trim; opt-in regeneration applies only to severe casual length/Markdown violations. Canon shares the post-reply personal extraction call and applies separate evidence rules. Semantic consistency across all slots is model-assisted, with a conservative local polarity check; human review is still needed.

Stored configuration uses `character.enabled`, `character.modules.<module>`, `character.context` and `character.channelOverrides.<channelId>`. Overrides can disable guild-enabled modules/context; they cannot activate guild-disabled modules. Switching the master or a dependency off invalidates pending influenced output. Direct/name-triggered replies keep their original memory snapshot across normal background learning and mood expiry; optional contributions revalidate context. Explicit forgetting still invalidates affected in-flight turns. Stored records remain available to authorized management until expiry or explicit clearing.

## Inspect, correct and forget

`/settings-character ledger` lists, edits, deletes or clears canon, mood or daily-sketch records. Choose a channel to see channel-scoped mood. The canon freeze stops new automatic learning while retaining existing entries. Owner personality/lore take precedence; changing the persona hash prevents use of old generated identity data.

Members can inspect and forget facts and relationship impressions through `/memory`. Impressions cite their supporting facts and provenance. Forgetting/correcting a supporting source or narrowing its channel visibility makes the old impression ineligible. Tone and teasing preferences come from fresh user customization, never from inferred consent. The memory settings group exposes character retention; it does not delete ordinary explicit facts.

Callback state stays on an ordinary event fact. Follow-ups need an explicit dated self-report, eligible provenance, current activity and access, an enabled module and a persistent daily guild quota. They ask how the event went without asserting it happened. Date normalization runs once per revision after a conditional planning reservation; unresolved dates wait for a revised fact, and transient normalization failures wait 30 minutes. The original eligible event message is the reply target; if unavailable in this channel, delivery is standalone rather than linked to unrelated activity. Pending claims expire; confirmed sends keep the Discord message ID. A timeout/crash after sending begins becomes `uncertain` and is not retried automatically. Known failures before delivery use bounded backoff, at most three attempts and a three-day callback age. Correcting or forgetting the event cancels an old pending revision; completed events are not repeated. Operators can inspect the event's `structuredValue.callback` in the database when investigating an uncertain outcome.

## Human review

Admins can use the **Felt like a bot** message command, or `/character-eval flag message:<id> category:<category>`, on recorded bot chat messages. Categories cover wrong person, assistant tone, timing, contradiction and reply length. The message command saves `other`; the slash command provides the specific category. Functional command output is not a chat review target.

`/character-eval probes` generates seven interview answers privately without tools, search, images or memory writes. `/character-eval pair question:<question>` generates a baseline/candidate pair randomized as A/B; `/character-eval label` saves a human preference. `/character-eval export` exports review metadata and synthetic outputs. Review data is separate from memory, bounded to 500 records and 30-day retention. Optional scheduled probes default off and run daily by default (minimum configurable interval: 60 minutes). Batches obey evaluation cooldowns and share guild concurrency; each answer reserves one unit of the optional-call budget, so an interview costs seven and a blind pair costs two. These synthetic pairs do not replace comparisons from real conversations.

Record reviewer judgments for identity consistency, correct speaker, stale/forgotten facts, welcome callbacks, appropriate timing, substantive completeness and truthful bot identity. Add consented regression fixtures for failures. Measure provider cost and interruptions as diagnostics. Do not use a judge-model score or message volume as the success criterion.

## Offline chronological replay

Use a consented, anonymized JSON manifest with pseudonymous numeric Discord IDs, never real member identifiers:

```json
{
  "consented": true,
  "anonymized": true,
  "turns": [
    {
      "timestampMs": 1791936000000,
      "channelId": "200000000000000001",
      "speakerId": "300000000000000001",
      "message": "Are you a bot or a real person?",
      "expected": ["honest-bot", "no-invented-past"]
    }
  ]
}
```

```sh
npm run eval:character-replay -- --fixture replay.json --persona personality.md --settings character-settings.json --output review.json
```

The settings file is the `character` object only. The runner requires configured chat providers, makes real provider calls, uses a new temporary SQLite database and an injected chronological clock, and does not connect or post to Discord. It feeds turns through the real conversation/memory/module services with tools/search/images disabled. The output is a human-review artifact, not a computed believability score. The temporary database location is printed for inspection; it is not the live bot database. On PowerShell installations that consume forwarded npm flags, invoke the equivalent `node node_modules/tsx/dist/cli.mjs src/scripts/replay-character-conversations.ts ...` directly.

Complete a week of probes and one-channel live review before broad rollout. PostgreSQL contract execution needs `MEMORY_TEST_DATABASE_URL`; SQLite tests do not establish live PostgreSQL behavior. No live pilot or real transcript replay is implied by the local implementation checks.
