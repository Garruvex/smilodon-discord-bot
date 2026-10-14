# Conversation participation and shared memory

Implemented against the 2026-10-14 review. This describes the code, not a verified production rollout. See [deployment and pilot instructions](chat-naturalness-deployment.md).

## Source and context boundaries

`SocialChatEligibility` centralizes game, access, feature, channel, and utility ancestry checks. Persisted message origins distinguish chat, link-fix, tool, system, and game outputs. Unresolved reply ancestry and unknown legacy bot outputs fail closed. Functional tool outputs and their human triggering messages are excluded from social observations, memory extraction, and follow-up reactions. Context-only lookups do not turn a normal chat into a functional utility interaction.

Context carries canonical account/message IDs, separate observed name variants, reply relationships, participants, and bounded current reaction snapshots. Names and message content are quoted data, not authority. Reaction turns have no invented human speaker; actor reaction timestamps are unknown unless actually observed. Alias collisions preserve all candidate account IDs. An indexed alias table supports exact token lookup; short Han labels require standalone tokens. Compatible Chat Completions providers advertise only capabilities they can execute; native tool providers refresh capability instructions after functional execution.

## Shared facts and forgetting

Shared personal memory is default-off per guild, including upgrades. `resolveMemoryScope` preserves private personal facts until `chat.sharedMemoryEnabled` is explicitly activated, then makes new eligible self-facts public within the configured audience: guild-wide in shared mode and channel-local in isolated mode. Session-only and disabled modes prohibit durable writes. Existing private facts remain private until separately reviewed backfill. This is explicit configuration, not automatic Discord permission classification. `/memory list` discloses audiences; forget-all also clears stored recent context.

Extraction preserves human author, original message ID, quoted evidence, source time, and source mode. Bot-authored and synthetic reaction evidence cannot create human facts. Listing and deletion authorize the person the fact concerns independently of public audience ownership. Corrections preserve source-backed name history. Forgetting removes earlier revisions and source-linked derived summaries, and persists cutoffs so old extraction cannot recreate forgotten evidence. New human statements after a cutoff may be retained. Older sessions lacking original evidence cannot be consolidated into public memories.

Observed aliases are scoped by authorized retained facts. They are not a complete guild identity directory. Ambiguous aliases are supplied as candidates instead of merging identities. Explicit memory-tool subject filters narrow retrieval while retaining the caller's access constraints.

## Episodes and scheduling

Shared channel/thread episodes require the existing channel-history opt-in and are distinct from per-speaker transcripts and durable facts. With channel history off, passive messages are not observed or hydrated into chat prompts. Stores retain at most 48 events per episode, 16,000 serialized characters, and 15 minutes. Selection favors relevant reply branches and recent context, bounded to 16 events / 8,000 characters. In-process episodes also have a 256-channel bound. Selected persisted events are refreshed against Discord eligibility; utility exclusions remove affected branches. Retention cleanup runs on startup and periodically; forgetting removes the user's messages and linked branches from memory and persisted episodes.

`ChatScheduler` runs one conversational job per bot-instance/guild/channel/thread with configurable concurrency per guild (default four). Queues allow 12 waiting jobs per channel and 256 globally; direct requests take priority, optional work is shed first. A new queued optional candidate replaces the older one. Burst candidates refresh after four quiet seconds with a ten-second maximum wait. Optional jobs expire after 30 seconds; changed context invalidates new continuation/spontaneous delivery, not existing name/reaction/bare-ping paths. Restart discards pending outputs.

Evaluation and output gates are independent. Silence still consumes evaluation capacity. Optional admission is per guild and configurable (default 100 turns per ten minutes); accepted turns finish their provider/tool workflow without application call-budget exceptions. Provider usage logs count actual attempts. Background summarization/extraction retains its separate scheduling. Text and emoji output reserve capacity atomically; failures release reservations. Meaningful direct requests bypass optional admission and unsolicited-output limits but retain queue and eligibility checks. Memory source evidence is read in one bounded batch and included before the final conservative prompt budget is applied.

## Participation decisions

Provider output maps to silent, react, reply, or reply-and-react with a target, compact reason, and expiry. Optional tool-capable turns first decide without executable tools; only an accepted reply enters the execution pass. Shadow decisions have no delivery, extraction, or tool side effects. First bare pings default to acknowledgment, with optional personality choice; equivalent short repeated pings are suppressed for ten seconds. Meaningful direct requests retain normal delivery.

Continuation and spontaneous participation are independent and default off. Spontaneous participation also needs an explicit channel allow-list. Existing name-triggered ambient behavior does not enable either feature. Master enablement, access, game/source exclusions, feature controls, channel overrides, and resolved budgets are checked before evaluation and delivery. The admin panel and translated slash settings expose the same policy.

## Research adopted and evaluation limits

- [Inner Thoughts (Liu et al., 2025)](https://arxiv.org/abs/2501.00383) informs the compact contribution/timing decision. The bot does not reproduce continuous inner-monologue generation or the paper's full multi-agent framework.
- [Generative Agents (Park et al., 2023)](https://arxiv.org/abs/2304.03442) informs bounded observation, retrieval, and episode continuity. This is not a simulation of agents or a reproduction of the full reflection architecture.
- [LongMemEval (Wu et al., 2024/ICLR 2025)](https://arxiv.org/abs/2410.10813) informs update, retrieval, temporal evidence, and abstention regression cases.
- [Evaluating Very Long-Term Conversational Memory of LLM Agents / LoCoMo (Maharana et al., 2024)](https://arxiv.org/abs/2402.17753) informs conversation-sequence and summary checks.

The repository uses Discord-specific fixtures and lifecycle tests; it does not claim published benchmark scores or dataset reproduction. Human review on the deployed server remains necessary for voice, contribution quality, and timing. Current diagnostics are bounded metadata; a full restricted/redacted prompt-capture interface is not implemented.
