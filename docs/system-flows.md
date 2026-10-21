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

## 4. Common chat lifecycle (all seven interactions)

Current as of 2026-10-22; see the [closing audit](chat-context-final-audit-2026-10-22.md) for the source/consumer matrix, limits and test evidence.

```text
MessageCreate / ReactionAdd
  -> BehaviorDispatcher / fresh SocialChatEligibility
  -> mention, ambient or reaction adapter
  -> registered ChatTurnSupport source port + registered persona configuration
  -> ChatConversationService scheduling, turn plan and work deadline
  -> runGuardedChatTurn (the only live conversation executor)
       -> one channel-visible snapshot, explicit role/user opt-out filter
       -> source-owned current/burst/history/ancestry and verified sessions
       -> authorized claims, relations, identities, configuration and images
       -> approved character preparation and optional decision projection
       -> deterministic ConversationDecisionEngine policy
       -> silent/emoji exit, or reply-only semantic examples/lore retrieval
       -> immutable approved request -> ConversationModelGateway
       -> frozen guardModelTransport -> provider attempts / reviewed tools
       -> attribution / voice repair under derived registered requests
       -> snapshot invalidation + fresh batched forget check -> immutable effect permit -> adapter delivery
       -> confirmed state commit and approved memory mutation batch
       -> fresh guarded post-turn extraction, consolidation and scoped drift
```

Mention, explicit reply, bare ping and matched name address have application-owned response destinations. Follow-up, group and reaction opportunities use context interpretation and deterministic participation policy. All modes share source eligibility and final effect controls. Interaction roles decide who can trigger; channel visibility and explicit collection opt-outs decide whose messages/reactions can be context. Admission does not walk reply ancestry. A bare ping can refer to an earlier untagged question. Quiet gaps alone do not discard otherwise eligible evidence; coalescing, expiry and work deadlines remain separate from relevance.

`FilePersonaSource` issues registered authored configuration and verifies file/bundle fingerprints. Lore/examples are selected under that authority. Learned drift is a separately verified channel-scoped source, never an unproven global file folded into persona configuration. Preferences remain style data for the currently authorized user. Birthday/server data enters through reviewed resource/tool reads.

Memory recall uses the mandatory frozen memory facade, source/subject/audience checks before external relevance work, source-owned queries and exact-text embedding admission. BM25/cosine rankings and RRF operate only on admitted candidates. Model proposals require reviewed immutable batches; shared and isolated modes permit durable writes, while session-only/disabled modes do not. Module-owned character records never enter ordinary recall.

All model capabilities use the frozen model facade, and embeddings use a separate facade outside caches. Missing/copied/modified approval fails before dispatch. Provider callbacks reuse event-invalidated Discord snapshots and revalidate configuration/resource authority for retries and tool continuations; delivery checks batched forget state again. Message edits/deletions, role/channel/thread changes and connection interruptions invalidate snapshots. Generic adapters without notifications retain full source validation. The guard cannot atomically undo already-dispatched external bytes.

Delivery occurs before session commit; confirmed delivery survives a later bookkeeping failure and is not blindly replayed. Post-turn work uses fresh source authority and shares mutation ordering. Session-only bot-origin proofs remain ephemeral. Unknown legacy records, unsupported tools and unauthorized cross-channel data remain excluded.

Diagnostics contain metadata only. `model.gateway.rejected` distinguishes approval/source/result failures from provider work; explain-message preserves actual recovery/delivery evidence. Paid replays, production deployment and live Discord timing are separate acceptance work.

## 5. Channel-context memory (scan / daily consolidation)

```text
ChannelSummaryScheduler                         (src/application/context/channel-summary-scheduler.ts)
  (hourly tick, plus one immediate tick on start)
  -> checkNow -> processChannel (per guild, per configured channel)
       -> runScan   (one-time backfill to a configured seed-days boundary)
       -> runDaily  (bounded catch-up of each day's new messages)
            -> summarizeAndIngest
                 -> GuardedBackgroundContext + BackgroundModelGateway.summarize
                 -> guardModelTransport -> summary provider attempts
                 -> validateGuildKnowledgeCandidates (channelScoped forced true)
                 -> approved immutable fact/relation batch
                 -> guarded MemoryEngine.ingest (source: "consolidation")
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

Background model inputs and downstream writes inherit the registered batch source proof, eligible subjects and channel audience. Job/source/member changes cancel actual provider attempts and persistence. Completed extraction reflection reopens the original eligible messages after worker locks are released; failed jobs cannot create character state. Unproven legacy summary text is excluded rather than treated as unrestricted shared knowledge.
