# Local Laya decision evaluation

This experiment compares classification on the existing 216 synthetic contextual
replay variations (English, Traditional Chinese and Japanese). It does not change
the live decision provider. Laya chooses relationship, intent, action and referent;
it does not invent candidate speech, evidence, exchange links or reply targets to
make its output look like the production decision contract.

## Start on the RTX 3080 server

Requires Docker Compose v2, a compatible NVIDIA driver and NVIDIA Container
Toolkit. Run from this repository on the Linux server:

```sh
nvidia-smi
docker compose -f compose.laya.yaml up -d --build
docker compose -f compose.laya.yaml logs -f laya
```

The separate service builds Laya 0.4.13 with PyTorch 2.14.0 CUDA 13.0, selects GPU 0
and preloads only the multilingual checkpoint. The first startup downloads weights
into a persistent named cache volume. `LAYA_GPU_ID` selects another GPU;
`LAYA_PORT` changes the published host port. The server uses the package's reviewed
checkpoint revisions and the report records the actual revision and device before
and after evaluation. Host drivers must support the CUDA wheel; a bigger GPU is
not the first troubleshooting step.

The default CUDA 13 build also supports the desktop's RTX 5080 (Blackwell).
The former CUDA 12.6 image could load the checkpoint and report `cuda` but failed
its first computation on that card with `no kernel image is available`.
Startup now executes CUDA indexing and FP16 matrix multiplication before starting
the HTTP service. A failed kernel check exits with device/build diagnostics.
On an RTX 3080 server with an older driver, `LAYA_TORCH_INDEX=cu126` selects the
alternative build; do not use that override for RTX 50-series cards.

After changing the build, recreate just the Laya service:

```sh
docker compose -f compose.laya.yaml up -d --build --force-recreate laya
```

The endpoint binds to host loopback. Run the harness on the server or use an SSH
forward from the development computer:

```sh
ssh -N -L 8000:127.0.0.1:8000 yohta-server
```

Optionally export `LAYA_API_KEY` before starting Compose and set the same variable
in the runner's environment. Do not put a key in command arguments or the URL.
The harness requires full authenticated health metadata and the default Laya
response format (`LAYA_JEV_STRICT=0`). `/health` alone proves only liveness; the
runner's `--require-cuda` checks the requested checkpoint's device before and after
the run. It cannot rule out a transient fallback that recovers between snapshots;
inspect container warnings as well.

## Run and compare

Inventory mode makes no HTTP calls and requires no instance credentials:

On PowerShell installations where npm consumes forwarded flags, replace
`npm run eval:laya --` with `node node_modules/tsx/dist/cli.mjs src/scripts/replay-laya-decisions.ts`.
The equivalent contextual runner is `src/scripts/replay-contextual-participation.ts`.

```sh
npm run eval:laya
```

Smoke test, then the full classification run:

```sh
npm run eval:laya -- --live --require-cuda --limit 3 --output data/evaluations/laya-smoke.json
npm run eval:laya -- --live --require-cuda --output data/evaluations/laya-contextual.json
```

The default endpoint is `http://127.0.0.1:8000`; override with `--url` or
`LAYA_BASE_URL`. Start with concurrency 1; `--concurrency 2` measures contention.
The first prediction can include kernel warmup. The multilingual token window is
explicitly 8192 with a 512-token question budget; inspect reported truncation
instead of assuming all conversation text was read. `--language zh-TW` and
`--scenario correction` select narrower diagnostic runs.

To compare with the existing provider, generate a cloud report with the existing
runner (this makes billed provider calls using the selected instance), then load
that report into the local evaluation:

```sh
npm run eval:contextual -- --live --instance pinecone --output data/evaluations/cloud-contextual.json
npm run eval:laya -- --live --require-cuda --baseline data/evaluations/cloud-contextual.json --output data/evaluations/laya-comparison.json
```

Use the same filters for a partial comparison. The report rejects incompatible
fixture revisions, unknown fixtures and duplicate IDs. It compares only matching,
valid pairs with untruncated local input. Cloud prompt/schema and responsibilities
differ: agreement counts are diagnostics, not proof of equal capability or accuracy.
Both runners use the same synthetic context lease; the Laya request uses a compact
representation of that evidence, with speaker IDs, reply bindings and elapsed time.

Reports live under ignored `data/evaluations/`. They include per-language/scenario
relationship accuracy, forbidden reply proposals, reply volume, high-confidence
relationship mistakes, latency, truncation, local token counts and paired cloud
choices. They omit conversation text, URLs and API keys. All transport/schema
failures remain failures rather than becoming silent decisions. Exit 1 means setup
or operation failure; exit 2 means at least one failed/truncated case, changed or
unverifiable checkpoint revision, or failed final CUDA check. Exit 0 means the
experiment completed, not that semantic acceptance passed.

## Interpreting the evidence

### Compare with native OpenAI Decisions

The original cloud contextual report measures a generative decision contract.
For the same four classification questions, input serialization and choice
descriptions as Laya, run the native Decisions benchmark instead:

```powershell
node node_modules/tsx/dist/cli.mjs src/scripts/replay-openai-decisions.ts --live --instance pinecone --output data/evaluations/openai-decisions-classification.json
```

It calls only `/v1/decisions` with `gpt-6-luna`; no reasoning effort or generative
fallback is used. It reads instance credentials without changing configuration.
`--format`, `--choices`, `--questions`, language/scenario filters and limits match
the Laya runner. Leave those switches at their defaults to compare with
`json-detailed-together`; select the same variant on both sides for other runs.
Use `--limit 3` for a billed smoke test first, then omit it for the full dataset.
Without `--live` it inventories fixtures without API calls. Measured token usage
includes usage reported on invalid/refused attempts. The classification report
does not test production admission, evidence/link binding or reply generation.

For that separate production-path test, use
`replay-contextual-participation.ts --live --native-decisions --instance pinecone`.
The native-only switch overrides decision selection in memory for this replay,
refuses reply/utility provider-role combinations, and makes no instance-file changes.
Without the switch, the runner follows the instance's current configuration, which
may still select the generative reply model even if the output filename says native.
To enable production routing, configure `DECISION_MODE=decisions` and
`DECISION_MODEL=gpt-6-luna` in the deployed instance. The replay's
`providerIdentity.provider` should be `openai-decisions`, and reasoning effort
should be null. Deployment and a scoped review remain separate from either replay.

Full contextual reports include `nativeConfidence` components for relationship,
link, evidence selection, target, action and referent, plus aggregate
`policyRejections`. These are selected-option probability masses, not generated
self-ratings. The existing admission floor remains 0.70; its applicability to
native probabilities must be measured rather than assumed. Inspect rejected
correct decisions alongside unwanted admissions before calibrating anything.

### Controlled input comparison

The default remains JSON + detailed choices + four questions together, preserving
the original request format. Revision 2 adds three independent switches:
`--format json|dialogue`, `--choices detailed|short`, and
`--questions together|separate`. Dialogue retains speaker identity, message order,
elapsed time, reply links and a CURRENT marker, using short human labels rather
than Discord IDs. Neither representation includes expected labels or scenario IDs.
Separate mode makes four sequential HTTP requests with the same case deadline;
it requires every answer and combines usage/truncation diagnostics. Its latency
is the total case duration, so it can be compared with the together mode.

Run the complete 2-by-2-by-2 comparison in PowerShell without rebuilding Laya:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/eval-laya-variants.ps1
```

`-Limit 3` is a smoke test; `-InventoryOnly` checks the matrix without model calls.
Each run writes eight distinct reports plus `comparison.json` to a new directory
under `data/evaluations/laya-variants-<timestamp>/`. It never replaces
`laya-baseline.json`. Compare both accuracy and unwanted replies, with matching
checkpoint revisions and language/scenario results; do not select a variant on
aggregate accuracy alone. This matrix is prompt exploration on the original
dataset, not independent validation. Any selected variant needs held-out examples.

- Relationship is the only fully labeled classification field. The fixtures also
  mark cases where a text reply is forbidden. Intent/referent agreement and action
  volume are exploratory; always choosing silence does not establish success.
- The 216 cases are a controlled matrix of eight scenarios, three languages,
  three time gaps and three speaker arrangements, not independent human dialogs.
- Confidence is an uncalibrated diagnostic. No confidence cutoff authorizes
  production decisions. Truncated results remain visible and are excluded from
  paired comparisons, but remain in the all-case accuracy denominator.
- Local token usage measures computation, not API billing savings. This runner
  does not measure generation costs, downstream retries or end-to-end savings.
- Before activation, add reviewed real-world slang, mixed-language and ambiguous
  reference cases; evaluate speaker/target/evidence selection and required replies.
  Then design the classification/generation split and test the actual policy path.

D&D evaluation is a later, separate dataset: action/target classification and
individual note screening are candidates. Existing scene-note rewriting and
narration audits produce text that this classifier cannot replace. Campaign rules,
state transitions and permissions stay in the deterministic engine. This harness
makes no D&D accuracy claim.

Protocol and deployment references:
[Laya HTTP API](https://nandhakishorm.github.io/laya/http-api/),
[Docker guide](https://nandhakishorm.github.io/laya/docker/),
[benchmarks and limits](https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md).
# Binary reply benchmark

For the explicit-policy experiment, run:

```powershell
node node_modules/tsx/dist/cli.mjs src/scripts/replay-reply-benchmark.ts --live --provider both --instance pinecone --require-cuda --policy contextual
```

The default `--policy baseline` preserves the original short question. Revision 2 records the selected policy and adds always-Yes/always-No controls and per-scenario metrics. The contextual variant specifies speaker ownership, explicit other recipients, missing context, and legitimate brief replies. It still asks just one yes/no question. Labels and scoring stay identical across variants. Because these rules were clarified after examining baseline errors, improvements on this dataset are development evidence; use separately reviewed, unseen conversations for final validation.

Use the shared yes/no benchmark for the current Laya versus OpenAI Decisions comparison:

```powershell
npm run eval:reply -- --live --provider both --instance pinecone --require-cuda
```

Start Laya's Docker service first. OpenAI-only runs use `--provider openai` without `--require-cuda` and do not need Docker. Omit `--live` for a free offline inventory. Output defaults to a new timestamped JSON report.

Both providers receive identical conversation history, speaker IDs, bot identity, current message, reply links, instructions and yes/no choices. Each makes one choice per scored case. There are no policy gates or confidence cutoffs, and no chat text is generated or sent. Reports include the exact input, expected label, prediction, confidence, latency and usage for inspection. Failed requests are separate from No predictions and count against all-labeled accuracy.

The inherited synthetic dataset has 162 provisionally labeled cases (72 Yes, 90 No). The 54 group-opening/thanks cases require human adjudication and are excluded from scoring: the old “text allowed” flag does not establish that a reply is required. These are developer-authored synthetic expectations, not independently reviewed human ground truth. Review them before treating this as a deployment acceptance benchmark. Earlier four-question tests and reports below are retained as historical experiments; their accuracy figures are not interchangeable with this binary benchmark.

