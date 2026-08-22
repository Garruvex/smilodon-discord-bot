# System Flows

This document walks concrete, end-to-end request paths through the codebase —
"what actually calls what, in what order" — as a companion to
[Architecture](architecture.md), which covers boundaries and invariants at a
higher level. Each section names the real files and classes involved so the
flow can be traced in the source rather than taken on faith.

## 1. Slash-command dispatch (`/play` as the example)

```text
Discord InteractionCreate
  -> Application.registerDiscordEvents        (src/bootstrap/application.ts)
  -> CommandDispatcher.dispatch                (src/application/commands/command-dispatcher.ts)
       -> CommandRegistry.find(commandName)
       -> AccessPolicyService.evaluate         (src/application/access/access-policy-service.ts)
            -> AccessPolicyEngine.evaluate      (src/application/access/access-policy-engine.ts)
       -> PlayCommand.execute                   (src/infrastructure/discord/commands/music/play-command.ts)
            -> PlaybackService.enqueue          (flow 2 begins here)
```

`CommandDispatcher.dispatch` looks the command up in `CommandRegistry`,
replies "Command unavailable" for an unknown name, otherwise runs
`AccessPolicyService.evaluate(command.access, command.module, interaction)`
before calling the handler at all. A denial is logged with its reason and
answered with a generic "Permission denied" — command bodies never see a
request that failed access control.

`AccessPolicyService.evaluate` first rejects anything without a cached guild
member (`AccessDenialReason.GuildRequired` — deliberately kept here rather
than in the shared rule chain, since a chat-tool invocation always has a
resolved member by construction), looks up the guild's `GuildConfiguration`,
builds an `AccessSubject` (guild/channel/user ids, role ids, permissions,
`isOwner`), and delegates to `AccessPolicyEngine.evaluate`. The engine runs a
**fixed ordered list** of `AccessRule` functions (`access-rules.ts`); the
first rule to return a decision short-circuits the rest, otherwise the
request is allowed by default. This is the same engine and rule chain that
chat-tool invocations use (`evaluateMusicToolAccess` in
`music-tool-support.ts`), so a slash command and its LLM tool binding can
never diverge on what they permit.

`PlayCommand` implements both `BotCommand` (the slash command path) and
`ChatToolBinding` (`executeAsTool`, so the model can call `play_music`
directly) — both paths end at the same `PlaybackService.enqueue`, but the
tool path re-runs `evaluateMusicToolAccess` itself since `CommandDispatcher`
never sees it. `CommandRegistry.validate` also enforces at registration time
that a command's role-match mode and its required role groups agree with each
other — a startup-time check, not a runtime one.

## 2. Music playback (`/play` through to the control panel)

```text
PlaybackService.enqueue                        (src/application/music/playback-service.ts)
  -> PlaybackRateLimiter.check
  -> requireVoiceChannel / assertSameVoiceChannel
  -> MusicPlayerGateway.enqueue
       -> LavalinkPlayerGateway.enqueue         (src/infrastructure/lavalink/lavalink-player-gateway.ts)
            -> manager.createPlayer / connect / prepareStageChannel
            -> searchWithFallback (Spotify -> YouTube)
            -> player.queue.add / player.play()
            -> MusicEventBus.publish("queue_changed")
```

The rate limit is recorded **before** the search runs, deliberately, so a
failed lookup still counts against the limit. `assertSameVoiceChannel` throws
`MusicVoiceChannelMismatchError` if the actor isn't in the same channel as an
already-connected player. `LavalinkPlayerGateway.enqueue` reuses an existing
player idempotently, sets the guild's configured default volume only for a
brand-new player, and falls back from Spotify search (`spsearch`) to YouTube
(`ytsearch`) on failure or an empty result.

Track-start/track-end reaching the panel is not something `PlaybackService`
pushes explicitly — `LavalinkPlayerGateway`'s constructor wires Lavalink's
own manager events (`trackStart`, `queueEnd`, `playerDestroy`) straight into
`MusicEventBus.publish`, so any native player-state change becomes a
`MusicStateChangedEvent`:

```text
MusicEventBus.publish(event)                   (src/application/music/music-event-bus.ts)
  -> ControlChannelService's subscription       (src/application/control-panel/control-channel-service.ts)
       -> PanelRefreshCoordinator.request        (src/application/control-panel/panel-refresh-coordinator.ts)
            -> ensurePanel (find/send/pin, via ControlPanelStateStore)
            -> playerGateway.getSnapshot(guildId)
            -> createPanelPayload (embed + progress bar + control rows)
            -> message.edit(...)
```

`PanelRefreshCoordinator` folds a burst of refresh requests for one guild
into a single latest-state edit, serialized so overlapping refreshes for the
same guild collapse instead of racing. A 5-second self-refresh timer
(`resetProgressRefreshTimer`) is re-armed from **player state** (playing and
not paused) rather than from edit success, so a transient Discord API
failure doesn't permanently stall the progress bar.

Button presses on the panel (`ControlChannelService.handleButton`) validate
the panel message identity, check the clicking member's role via
`canControl`, render an optimistic prediction (`control.predictSnapshot`)
before the real round trip, execute the control inside `guildLocks.run` (a
per-guild `KeyedSerialQueue` — this is what stops a double-click, or a
startup panel-init racing an event-driven refresh, from both sending a fresh
panel message), then unconditionally refresh again to reconcile with ground
truth. Typed song requests in the control channel
(`ControlChannelService.handleMessage`) go through the same
`PlaybackService.enqueue` path with a "Searching…" placeholder that gets
edited into the result card and then auto-deleted.

## 3. Guild bootstrap (`/setup initialize`)

```text
SetupCommand.execute                            (src/infrastructure/discord/commands/setup/setup-command.ts)
  -> LocalGuildSetupService.initialize           (src/application/setup/local-guild-setup-service.ts)
       -> createTrackedRole x3 (admin, music-controller, restricted)
       -> resourceGateway.createTextChannel (control channel)
       -> grantRoleIfMissing x2 (initializer gets admin + music-controller)
       -> guildConfigurationProvider.create      (writes the guild YAML — see below)
       -> completeSetup(guildId, profile, wasFreshSetup: true)
       -> AuditLogService.log
```

Resource creation is conditional per-field — a caller-supplied role or
channel id is used as-is and never created or rolled back. Any failure
**before** the profile is persisted triggers `rollbackCreatedResources`,
which deletes only the roles/channel created during *this* run. Once the
profile write succeeds, nothing rolls back further: a later failure (panel
setup, command deployment) is recovered simply by re-running
`/setup initialize`, which finds the existing profile and jumps straight to
`completeSetup` (`wasFreshSetup: false`, and `assertBotPermissions` is
skipped on this resume path).

`completeSetup` runs, in order: validate the profile's control channel is
still fetchable, resolve role ids for the reply text,
`ControlChannelService.ensureGuildPanel` (creates/finds and pins the panel —
same `ensurePanel` as flow 2), then
`CommandDeploymentService.deploy(profile)` (built from
`commandRegistry.getByEnabledModules(profile.features)`).

The actual YAML write (`LocalGuildConfigurationProvider.create`, in
`src/config/guild-configuration-provider.ts`) validates the document against
`guildConfigurationFileSchema` (zod), writes it to a `.tmp` file, then
`renameSync`s it into place — so a concurrent `reloadFromDisk` never observes
a half-written file — and rolls back (`rmSync`) if the freshly-written file
fails full-set validation on reload (for example, two files now claim the
same `guildId`).

## 4. Mention chat (a mention message to a delivered reply)

```text
Events.MessageCreate                            (src/bootstrap/application.ts)
  -> ControlChannelService.handleMessage (control-channel requests take priority)
  -> BehaviorDispatcher.dispatch(MessageCreated)
       -> MentionChatBehavior.execute            (src/infrastructure/discord/behaviors/mention-chat-behavior.ts)
            -> ChatAccessService.canUseMentionChat
            -> FilePersonaSource.resolve          (src/infrastructure/chat/file-persona-source.ts)
            -> ChatConversationService.run        (src/application/chat/chat-conversation-service.ts)
```

`MentionChatBehavior` dedupes by message id (5-minute TTL), checks
`features.chatbot` and role/channel access, strips the mention out of the
prompt, resolves the reply chain and (if enabled) channel history and image
attachments. An empty prompt is only rejected when there are also no images
and no reply chain — replying to a message with a bare mention is treated as
a valid question about that message.

`FilePersonaSource.resolve` loads the guild's `personality.md`; if a compiled
`personality.bundle.json` sits next to it and its stored content hash still
matches the current file, the bundle's always-sent "core" plus
retrieval-selected "lore" chunks are used instead of the raw file. A stale or
missing bundle falls back to the raw file (truncated to 32,000 characters)
with no lore. Persona drift (`resolvePersonaDrift`, opt-in per guild) is
similarly discarded if its stored `personalitySourceHash` no longer matches
the current personality — drift computed against an edited personality file
is untrustworthy. `examples.md` follows the same bundle-vs-raw-file pattern.

`ChatConversationService.run` is the orchestrator, serialized per
`guildId:userId` via a `KeyedSerialQueue` so a user's own messages can't
race each other into inconsistent session state:

1. Loads session history (`stateStore.load`) and narrows it
   (`promptHistorySelector.select`).
2. In parallel: `memoryEngine.recall(...)` (flow continues below),
   `userCustomizationStore.load`, `birthdayStore.getBirthday`.
3. Narrows the example-exchange pool and persona-lore chunks to what's
   relevant this turn (`exampleExchangeSelector`, `personaLoreSelector`).
4. Calls `provider.reply({...})` — the one LLM round trip for this turn,
   including guild knowledge, private memory, persona, examples, and (if
   enabled) the tool list minus any guild-disabled tools.
5. Validates the model's structured output —
   `validateMemoryActions` (private-memory upserts/removals) and
   `validateGuildKnowledgeCandidates` (guild-knowledge candidates) — checking
   topic vocabulary, subject authorization, and secret/length rules.
6. Calls `deliver(...)` (posts/edits the Discord reply) **before** committing
   session state, so a later commit failure still leaves the user with a
   delivered reply; the commit failure surfaces as `ChatStateCommitError`,
   caught by `MentionChatBehavior` to DM an apology rather than silently
   losing the exchange.
7. `stateStore.commitSuccessfulExchange` records the turn and returns any
   `droppedExchanges` — exchanges evicted from the rolling history window.
8. Validated memory actions and guild-knowledge candidates become
   `ProposedMemory[]` and go to `memoryEngine.ingest(...)`.
9. `consolidateDroppedExchanges` runs off the critical path (failures are
   logged and swallowed, never surfaced to the user): it summarizes the
   exchanges that just aged out into durable `scene_summary` guild
   knowledge, and separately evolves the persona-drift overlay if enabled.

Ambient (non-mention) replies share this same service method through
`AmbientChatBehavior`: if the model chooses not to reply, `deliver` is never
called, and if it still emitted memory proposals with no reply text, those
are ingested without a session-exchange write.

### The memory engine (`src/application/memory/memory-engine.ts`)

`DefaultMemoryEngine` is what `recall` and `ingest` above actually do:

- **`recall`** fetches candidates (`repository.findRecallCandidates`), scores
  them with BM25 over a per-call corpus, and — when an embeddings client is
  configured — separately ranks them by cosine similarity against the
  embedded query (memories with no embedding, or a dimension mismatch, are
  excluded from that ranking rather than tying at the bottom). The two
  rankings are merged with **Reciprocal Rank Fusion** rather than summed
  directly, since their scales aren't comparable, and `selectByRelevance`
  keeps as many results as fit under an 8,000-character budget.
- **`ingest`** is a no-op entirely when the resolved channel mode disallows
  durable writes (e.g. isolated/disabled channels). Each proposal is
  validated, then either removed (topic/slot match) or upserted.
- **`upsertOne`** resolves the final scope via `resolveMemoryScope` — the
  guild's configured channel mode is authoritative over whatever
  `channelScoped` flag the model returned, since the model's flag can't be
  trusted for an isolated channel. It also resolves the initial status:
  private memories and guild/community facts self-activate immediately; a
  fact **about a specific member** only self-activates when that member's
  own message is the evidence behind it — a claim one member makes about
  another stays an unconfirmed `"candidate"`.
- **`checkForConflicts`** runs after an active memory with an embedding is
  written: it finds other active memories about the same subject/scope,
  compares cosine similarity, and uses a deterministic tie-break
  (`createdAt` then `id`) so only the definitionally-later memory can
  supersede — this is what stops two memories ingested at nearly the same
  time from both trying to supersede each other and leaving neither active.
  Above the similarity threshold, an optional LLM classifier decides
  supersession; if that classifier call fails, the engine fails **safe
  toward not superseding** — the worst case is a stale duplicate surviving
  longer, never a memory silently vanishing.

`src/application/chat/guild-memory-selector.ts` and `user-memory-selector.ts`
implement a very similar BM25+RRF selection but are **not wired into
`dependencies.ts` or `ChatConversationService`** — they predate the unified
`MemoryEngine.recall` path and are dead code today, kept here as a note so
they aren't mistaken for an active part of this flow.

## 5. Channel-context memory (scan / daily consolidation)

```text
ChannelSummaryScheduler                         (src/application/context/channel-summary-scheduler.ts)
  (hourly tick, plus one immediate tick on start)
  -> checkNow -> processChannel (per guild, per configured channel)
       -> runScan   (one-time backfill to a configured seed-days boundary)
       -> runDaily  (bounded catch-up of each day's new messages)
            -> summarizeAndIngest
                 -> ChannelMessageSummarizer.summarizeChannelMessages
                 -> validateGuildKnowledgeCandidates (channelScoped forced true)
                 -> MemoryEngine.ingest (source: "consolidation")
```

`processChannel` skips a channel entirely if its resolved memory mode is
disabled/session-only. A channel present in both the scan and daily sets has
its daily high-water mark seeded from the scan's completion, so daily
consolidation doesn't immediately re-summarize the history the scan just
captured. Both scan and daily read history in bounded batches (at most 75
messages or ~40,000 characters, whichever comes first) so a busy channel
makes steady incremental progress across ticks instead of one unbounded
request; a batch's `batchId` is computed deterministically so a retried
batch reuses the same id for dedup provenance.

`summarizeAndIngest` resolves, per extracted fact, whether the batch itself
contains evidence that the fact's own subject asserted it — a
member-subject fact only self-activates when that member is the one who
said it in this batch, regardless of how much of the rest of the channel
corroborates the claim. Daily consolidation slots each fact under
`daily.YYYY-MM-DD.<slot>` so the same topic consolidated on different days
never collides; scan uses the model's raw slot instead.

The checkpoint (`ChannelSummaryCheckpointStore`) only advances after a batch
fully succeeds — unlike an interactive chat turn, where a memory-write
failure is logged and the turn continues, a background batch's partial
ingest failure is treated as a hard failure and the checkpoint is **not**
advanced, so nothing is silently skipped past. Disabling a guild's `chatbot`
feature pauses all channel-context processing without touching checkpoints;
re-enabling it resumes exactly where it left off.
