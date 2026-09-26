# Milestone 0 report: headless DM harness

Status of the exit criteria in the [plan §12](dnd-dm-bot-plan.md#12-delivery-milestones-and-exit-criteria), the measured numbers, the playtest rubric, and what moved to later milestones.

## How to reproduce

```bash
# Offline and deterministic: rule-based DM, scripted players
npm run campaign:harness -- --language both --rounds 8 --seed 1

# Live model (keys from the instance env file), model-played awkward table, recorded for free replay
DOTENV_CONFIG_PATH=config/instances/pinecone.env npm run campaign:harness -- \
  --dm openai-responses --model gpt-5.6-luna --reasoning-effort none \
  --cast simulated --language both --rounds 8 --seed 2 --record calls.json --out report.md

# Replay a recording: no API calls, byte-identical report
npm run campaign:harness -- --dm openai-responses --model gpt-5.6-luna --cast simulated \
  --language both --rounds 8 --seed 2 --replay calls.json --out report.md

# Keep the game in a SQLite file
npm run campaign:harness -- --language en --db game.sqlite
```

Casts: `scripted` (cautious rogue, chaotic fighter, quiet cleric), `adversarial` (rules-lawyer, off-topic, prompt-injection attacker, scripted), `simulated` (the same three awkward personas played by the model).

## Exit criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| Scripted playthroughs in both languages | Met | Offline and live runs in `en` and `zh-TW`, 8 rounds each, including the chapel fight |
| Latency target (p50 under 8 s, p95 under 20 s per round) | Met at reasoning effort `none` | gpt-5.6-luna: p50 5.9 s / p95 18.4 s (en), p50 6.3 s / p95 11.3 s (zh-TW). At `low` effort p50 was about 9 s, so effort `none` is the setting to use |
| Length target (80% of narrations in range) | Measured, see below | The report checks 60–180 words or 120–360 characters, wider than the prompt's 80–150 / 150–300 |
| Spotlight | Met | Every hero acted or passed in every run |
| Secret leak scan | Clean in every live run | Planner-only notes never reached the Narrator, including the injection persona's attempts |
| Simplified-character scan (`zh-TW`) | Clean | One false alarm (斗篷) fixed |
| Cost per session | Known in tokens | See below; dollars need the model's price, pass `--input-price`, `--cached-price`, `--output-price` |
| Internal playtest rubric passes | **Pending a human rating** | Rubric below; transcripts are in the run reports |
| Restart during play | Met for the engine and store | Saved rolls, timers, and command IDs survive a restart; a killed process loses only its open transaction |

## Tokens per session

Effort `none`, 8 rounds including a fight, English: about 47,000 input tokens (almost none cached) and 3,200 output tokens; `zh-TW` is about 65,000 in and 4,500 out. A Live hour is about 25 rounds, so roughly **150,000–200,000 input and 10,000–14,000 output tokens per Live hour**. Prompt caching showed 0–8% in these runs even though the adventure text at the front of each prompt is identical between calls; it is the largest cost lever still to investigate. Dollar cost is those totals times the model's prices.

## Playtest rubric

Rate each transcript 1–5 per row. Milestone 0 passes when every row averages 3.5 or higher across at least two raters and no row has a 1.

| Row | 1 | 3 | 5 |
| --- | --- | --- | --- |
| Fun | Flat or confusing; I would not play again | Fine; some moments landed | I want the next round; a moment I would retell |
| Clarity | I often could not tell what happened or what to do | Usually clear | Always clear what happened and what I can do next |
| Fairness | Results contradicted the dice or the rules | Mostly consistent | Every result matched the roll; refusals were explained |
| Felt heard | My action was ignored or misread | Acknowledged | My exact choice shaped what happened, including quiet players |
| Pacing | Long waits or rushed scenes | Acceptable | Each round felt about as long as it should |

Also note per transcript: any narration that contradicted the state, any invented plot element, any secret revealed, and any moment the table would have laughed or cheered.

## Known findings from the live runs

- Narration once invented hooks not in the adventure (an underground stair, a "dark shape"); the prompts now forbid new threats, places, and passages, and the next runs showed none.
- The planner correctly ruled impossible any action that referred to a place the party had left (asking Garrick a question in the chapel).
- The injection persona claimed new rules, free items, and the DM's secret notes in every round; every attempt was refused and no secret leaked.

## Moved to later milestones

- **Named-NPC action choice by the Planner** (Skarn choosing among legal actions, with a fallback to his tactic): needs a waiting state in combat and belongs with Discord combat, milestone 2. Ordinary and named monsters currently use their tactic profiles, as the plan allows for ordinary monsters.
- **Planner clarification and conflicting-action handling**: needs a private prompt to a player, so it lands with the Discord round flow, milestone 1.
- **Change NPC attitude and grant item** story effects: need NPC attitude and inventory state, milestone 1 with the character hub.
- **Death rules**: after a victory a hero at 0 HP wakes with 1 HP; a lost fight leaves heroes as they fell. Deaths, and what a lost fight means for the story, are a design decision for the Discord combat milestone.
- Hero opportunity attacks and death saves roll automatically; the Discord prompts come with milestone 2.
- Splitting `combat-flow.ts` (about 750 lines) and untangling the engine modules that import each other in a cycle are worth doing before the Discord work adds more to it.
