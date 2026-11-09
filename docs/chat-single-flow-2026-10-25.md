# One chat flow and one admission gate

Current state, 2026-10-25. This supersedes the rollout settings in the dated plans, acceptance notes and audits (`flowVersion`, `contextual_v1`, `retrievalMode`, `continuationFailureMode`, the context time-window, gap, summary and shadow options). Those documents remain historical records.

## What exists now

- **One flow.** Every turn reads guarded text context and uses the contextual decision. There is no legacy flow, no history-mode choice and no separate fallback reply when the decision model is missing or fails; that case is silence with a recorded reason.
- **One admission gate.** `admitChat` / `ChatPolicy.admit` in `src/application/chat/chat-policy.ts` decides whether an interaction may run. Discord adapters, the policy explanation (`effectiveChatPolicy`) and diagnostics all use it.
- **One trigger vocabulary.** `direct_mention`, `explicit_reply`, `bare_ping`, `name_address`, `implicit_followup`, `group_conversation`, `reaction`. Requests carry a single `interaction` field.
- **One request builder.** `buildChatTurnInput` in `src/infrastructure/discord/behaviors/chat-turn-request.ts` assembles the request for mention, name-address and reaction turns. Each behavior supplies only what differs.
- **Ordinary messages become neutral candidates.** The candidate buffer waits a bounded time, then the decision stage decides meaning. Whether a decision model is configured is not a routing rule.

## Settings

| Area | Controls |
| --- | --- |
| Context (`/settings-character context`) | History on/off, messages to read (8-48), character budget, messages used for decisions |
| Participation | Follow-ups, group participation, observed and spontaneous channels, activity preset, bare-ping style, preview mode, per-channel overrides, advanced limits |
| Policy report (`/settings-participation policy`) | Read-only view of what is on or blocked in a channel, and why |

Existing configuration files that still contain the retired fields load normally; the fields are ignored. Saved diagnostic traces using the old trigger names are upgraded when read.
