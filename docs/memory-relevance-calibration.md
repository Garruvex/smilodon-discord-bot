# Memory relevance calibration

`bm25Score` combines lexical BM25 relevance with subject and recency priors.
The production defaults preserve the original heuristic behavior, but all
three values are injectable through `Bm25ScoreWeights` so they can be tuned
against labeled retrieval cases.

Run the bundled illustrative dataset with:

```powershell
npm run eval:memory-relevance
```

Run a reviewed dataset by passing its path:

```powershell
npm run eval:memory-relevance -- path/to/memory-relevance-eval.json
```

Each case contains the query context, recall candidates, the IDs that should
be retrieved, and either a `calibration` or `validation` split. Optional
`maxResults` and `maxSerializedChars` fields reproduce result-count and prompt
budget constraints. The CLI searches the configured weight grid, orders it by
the calibration objective, and reports validation metrics without using them
to choose the weights.

The objective is:

```text
0.50 * recall
+ 0.25 * nDCG
+ 0.15 * mean reciprocal rank
+ 0.10 * precision
```

Before changing `defaultBm25ScoreWeights`, replace the example data with a
representative reviewed set. Include direct and implicit subject references,
fresh irrelevant memories, old relevant memories, revisions, multiple
languages, and realistic candidate volume. Keep validation cases separate and
do not choose weights by their validation score.

## Collecting cases through the bot

Collection is disabled by default because traces contain the user's query,
recent conversation context, and memory candidate text. Enable an opt-in sample
for one bot instance:

```dotenv
MEMORY_RELEVANCE_EVAL_SAMPLE_RATE=0.1
```

By default, traces exclude private personal-memory candidates. If affected
users have explicitly consented to owner review, private candidates can be
included with `MEMORY_RELEVANCE_EVAL_INCLUDE_PRIVATE=true`. Query and recent
channel text are still captured in either mode, so disclose the collection and
apply the server's normal retention/privacy policy.

Restart the bot and redeploy its application commands. The bot owner can then
review samples privately:

1. `/memory-eval pending` shows the newest unreviewed query and up to 15
   candidates. A check mark identifies candidates the live scorer selected;
   traces with more candidates include the complete trace as an attachment.
2. `/memory-eval label` records every candidate that should have been relevant
   and assigns the case to the calibration or validation split.
3. `/memory-eval skip` discards ambiguous, sensitive, or otherwise unusable
   samples.
4. `/memory-eval export` downloads every labeled case for that server as JSON
   accepted by `eval:memory-relevance`.

Raw append-only traces remain under
`<RUNTIME_DATA_DIRECTORY>/memory-relevance/traces.jsonl`. Protect that directory
like other private bot state and delete the trace file when collection is no
longer needed. Set the sample rate back to `0` after enough cases are collected.
