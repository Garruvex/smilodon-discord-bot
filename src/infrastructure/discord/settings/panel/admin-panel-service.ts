import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  type Client,
  type Guild,
  type Message,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type NewsChannel,
  type PermissionsString,
  type TextChannel,
} from "discord.js";
import type { Logger } from "pino";

import type { AuditLogService } from "../../../../application/audit/audit-log-service.js";
import { KeyedSerialQueue } from "../../../../application/concurrency/keyed-serial-queue.js";
import { settingsText } from "../../../../application/i18n/settings/index.js";
import { texts } from "../../../../application/i18n/texts.js";
import type { AdminPanelHealth, AdminPanelIssue } from "../../../../application/settings/admin-panel-health.js";
import type { AdminPanelStateStore } from "../../../../application/settings/admin-panel-state-store.js";
import type { AppliedSettingsChange, SettingsUpdateService } from "../../../../application/settings/settings-update-service.js";
import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import type { SettingsEngine } from "../engine/settings-engine.js";
import { controlIds } from "./control-ids.js";
import { replyWithResult, SettingsControlHandler, type ControlOutcome } from "./control-handler.js";
import {
  firstMessageKey,
  panelUnits,
  renderPanelHeader,
  renderUnitMessages,
  unitTitle,
  type PanelLastChange,
  type PanelMessage,
} from "./panel-messages.js";
import { panelValues } from "./panel-values.js";

type PanelChannel = TextChannel | NewsChannel;

export const adminPanelPrefix = "adm";
const headerKey = "header";
const lastChangeSummaryLimit = 200;
// The registered setting that holds the panel's channel.
const panelSettingPath = "access.admin-panel";

// What the bot needs in the panel channel to keep the panel there.
const requiredPermissions: readonly PermissionsString[] = ["ViewChannel", "SendMessages", "ReadMessageHistory"];

// A deleted panel message is reposted after a short wait (so a burst of
// deletions is one repost), but only so often: past that, something keeps
// deleting it and reposting would just feed it.
const healDelayMs = 5_000;
const healWindowMs = 10 * 60_000;
const maxHealsPerWindow = 3;

// The admin panel: a header plus one message per settings section in the
// guild's channels.adminPanel, kept in sync with the config. It's a surface
// of SettingsEngine like the /settings-* commands — every control runs the
// same setting through the same engine — and every write, from any surface,
// redraws it through the update service's change listener.
//
// It also looks after itself: a deleted panel message is reposted, members
// can't post in the channel, a deleted channel turns the panel off, and
// what it can't fix is kept in AdminPanelHealth for /status.
export class AdminPanelService {
  private readonly ids = controlIds(adminPanelPrefix);
  private readonly controls: SettingsControlHandler;
  private readonly queue = new KeyedSerialQueue();
  private readonly lastChanges = new Map<string, PanelLastChange>();
  // messageId → the rendered JSON last written to it, so a refresh only
  // edits messages whose content actually changed.
  private readonly written = new Map<string, string>();
  // Messages the panel is deleting itself, so their delete events aren't
  // mistaken for damage.
  private readonly deleting = new Set<string>();
  private readonly healTimers = new Map<string, NodeJS.Timeout>();
  private readonly heals = new Map<string, number[]>();
  private readonly healingPaused = new Set<string>();

  public constructor(
    private readonly client: Client,
    private readonly profiles: GuildConfigurationProvider,
    private readonly engine: SettingsEngine,
    updater: SettingsUpdateService,
    private readonly store: AdminPanelStateStore,
    private readonly health: AdminPanelHealth,
    private readonly auditLogService: AuditLogService | null,
    private readonly logger: Logger,
  ) {
    this.controls = new SettingsControlHandler(engine, profiles, this.ids, { kind: "panel" });
    // Not awaited: a slow redraw mustn't hold up the reply to the change.
    updater.addListener((change) => {
      this.handleSettingsChange(change);
      return Promise.resolve();
    });
    engine.bindAdminPanel(this);
  }

  public initialize(): void {
    for (const profile of this.profiles.getAll()) {
      if (profile.channels.adminPanel || this.store.find(profile.guildId)) void this.refresh(profile.guildId);
    }
  }

  // Redraws the guild's panel, posting whatever's missing. `force` re-edits
  // messages even when unchanged (resetting a select a refused change left
  // showing the admin's pick).
  public refresh(guildId: string, force: ((key: string) => boolean) | "all" = () => false): Promise<void> {
    return this.queue.run(guildId, async () => {
      try {
        await this.writePanel(guildId, force);
      } catch (error) {
        this.logger.error({ err: error, guildId }, "Admin panel refresh failed");
      }
    });
  }

  // Takes the whole panel down and posts it again in order, and resumes
  // reposting deleted messages. False when there's no panel channel.
  public async repair(guildId: string): Promise<boolean> {
    if (!this.profiles.find(guildId)?.channels.adminPanel) return false;
    this.healingPaused.delete(guildId);
    this.heals.delete(guildId);
    await this.queue.run(guildId, async () => {
      const state = this.store.find(guildId);
      if (state) {
        await this.removeMessages(guildId, state.channelId, Object.values(state.messages));
        await this.store.delete(guildId);
      }
    });
    await this.refresh(guildId, "all");
    return true;
  }

  // Message deletions anywhere; only the panel's own messages matter.
  public handleMessagesDeleted(guildId: string | null, channelId: string, messageIds: readonly string[]): void {
    if (!guildId) return;
    const state = this.store.find(guildId);
    if (!state || state.channelId !== channelId) return;
    const panelMessageIds = new Set(Object.values(state.messages));
    const damaged = messageIds.filter((id) => panelMessageIds.has(id) && !this.deleting.delete(id));
    if (damaged.length === 0) return;
    for (const id of damaged) this.written.delete(id);
    this.scheduleHeal(guildId);
  }

  // The panel channel was deleted: turn the panel off through the engine,
  // as the bot, so the change is audited like any other.
  public async handleChannelDeleted(guildId: string | null, channelId: string): Promise<void> {
    if (!guildId) return;
    const profile = this.profiles.find(guildId);
    const registered = this.engine.find(panelSettingPath);
    if (!profile || profile.channels.adminPanel !== channelId || !registered) return;
    const result = await this.engine.run(registered, {
      guildId,
      guild: this.client.guilds.cache.get(guildId) ?? null,
      actorUserId: this.client.user?.id ?? "",
      language: profile.language,
      values: panelValues({ lists: { channel: [] } }),
    }, { kind: "panel" });
    if (result.kind === "rejected") {
      this.logger.warn({ guildId, channelId, reason: result.message }, "Could not clear the deleted admin panel channel");
      return;
    }
    await this.report(guildId, [{ kind: "channel-deleted" }]);
  }

  public async handleComponent(interaction: MessageComponentInteraction): Promise<void> {
    if (!interaction.inCachedGuild()) return;
    await this.finish(interaction, await this.controls.handleComponent(interaction));
  }

  public async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.inCachedGuild()) return;
    await this.finish(interaction, await this.controls.handleForm(interaction));
  }

  private async finish(
    interaction: MessageComponentInteraction<"cached"> | ModalSubmitInteraction<"cached">,
    outcome: ControlOutcome,
  ): Promise<void> {
    const ui = texts[this.profiles.find(interaction.guildId)?.language ?? "en"];
    switch (outcome.kind) {
      case "opened":
        return;
      case "refresh":
        await this.refresh(interaction.guildId, "all");
        return;
      case "stale":
        await interaction.reply({ content: ui.admin.panel.stale, flags: MessageFlags.Ephemeral });
        await this.refresh(interaction.guildId, "all");
        return;
      case "ran":
        await replyWithResult(interaction, outcome, ui);
        // A refused change leaves the admin's pick showing in its select;
        // redraw the messages that hold it. (Accepted changes redraw
        // through the change listener.)
        if (outcome.result.kind === "rejected" || outcome.result.kind === "empty") {
          await this.refresh(interaction.guildId, "all");
        }
    }
  }

  private handleSettingsChange(change: AppliedSettingsChange): void {
    const lines = change.description.split("\n").map((line) => line.trim()).filter(Boolean);
    const summary = (lines.length > 1 ? lines.slice(1, 3) : lines).join("; ");
    this.lastChanges.set(change.guildId, {
      summary: summary.length <= lastChangeSummaryLimit ? summary : `${summary.slice(0, lastChangeSummaryLimit - 1)}…`,
      userId: change.actorUserId,
      at: new Date(),
    });
    void this.refresh(change.guildId);
  }

  private scheduleHeal(guildId: string): void {
    if (this.healingPaused.has(guildId)) return;
    clearTimeout(this.healTimers.get(guildId));
    const timer = setTimeout(() => {
      this.healTimers.delete(guildId);
      void this.heal(guildId);
    }, healDelayMs);
    timer.unref();
    this.healTimers.set(guildId, timer);
  }

  private async heal(guildId: string): Promise<void> {
    const now = Date.now();
    const recent = (this.heals.get(guildId) ?? []).filter((at) => now - at < healWindowMs);
    if (recent.length >= maxHealsPerWindow) {
      this.healingPaused.add(guildId);
      const channelId = this.store.find(guildId)?.channelId;
      this.logger.warn({ guildId, channelId }, "Admin panel keeps being deleted; stopped reposting it");
      if (channelId) await this.report(guildId, [...this.health.get(guildId), { kind: "healing-paused", channelId }]);
      return;
    }
    this.heals.set(guildId, [...recent, now]);
    await this.refresh(guildId);
  }

  private async writePanel(guildId: string, force: ((key: string) => boolean) | "all"): Promise<void> {
    const profile = this.profiles.find(guildId);
    const state = this.store.find(guildId);
    const channelId = profile?.channels.adminPanel ?? null;

    // Moved or turned off: take the old panel down first.
    if (state && state.channelId !== channelId) {
      await this.removeMessages(guildId, state.channelId, Object.values(state.messages));
      await this.store.delete(guildId);
      this.healingPaused.delete(guildId);
      this.heals.delete(guildId);
    }
    if (!profile || !channelId) return;

    const channel = await this.fetchPanelChannel(guildId, channelId);
    if (!channel) {
      this.logger.warn({ guildId, channelId }, "Admin panel channel is missing or not a text channel");
      return;
    }
    const missing = this.missingPermissions(channel);
    if (missing.length > 0) {
      await this.report(guildId, [{ kind: "missing-permissions", channelId, permissions: missing }]);
      return;
    }
    const issues: AdminPanelIssue[] = [];
    if (!await this.lockChannel(channel)) issues.push({ kind: "cannot-lock", channelId });
    if (this.healingPaused.has(guildId)) issues.push({ kind: "healing-paused", channelId });

    const messages: Record<string, string> = { ...(this.store.find(guildId)?.messages ?? {}) };
    const sections = await this.renderSections(profile, channel);
    const desired = [this.renderHeader(profile, channel, messages), ...sections];
    const forced = (key: string): boolean => force === "all" || force(key);

    // Panel messages stay in order: from the first one that has to be
    // posted, everything after it is posted again too. While reposting is
    // paused, only what's still there is kept up to date.
    const paused = this.healingPaused.has(guildId);
    let reposting = false;
    for (const [index, entry] of desired.entries()) {
      const existing = !reposting && messages[entry.key] ? await this.fetchMessage(channel, messages[entry.key]!) : null;
      if (existing) {
        await this.write(existing, entry, forced(entry.key));
        continue;
      }
      if (paused) continue;
      if (!reposting) {
        reposting = true;
        const later = desired.slice(index + 1).flatMap((next) => (messages[next.key] ? [messages[next.key]!] : []));
        await this.removeMessages(guildId, channelId, later);
      }
      const sent = await channel.send(entry.payload);
      messages[entry.key] = sent.id;
      this.written.set(sent.id, this.json(entry));
    }

    // A section that shrank, or a setting that was removed.
    const wanted = new Set(desired.map((entry) => entry.key));
    const leftover = Object.entries(messages).filter(([key]) => !wanted.has(key));
    await this.removeMessages(guildId, channelId, leftover.map(([, id]) => id));
    for (const [key] of leftover) delete messages[key];

    // The header's contents link to the sections, which may only just have
    // been posted.
    const header = messages[headerKey] ? await this.fetchMessage(channel, messages[headerKey]) : null;
    if (header) await this.write(header, this.renderHeader(profile, channel, messages), false);

    await this.store.save({ guildId, channelId, messages });
    await this.report(guildId, issues);
  }

  private async write(message: Message, entry: PanelMessage, force: boolean): Promise<void> {
    const json = this.json(entry);
    if (force || this.written.get(message.id) !== json) await message.edit(entry.payload);
    this.written.set(message.id, json);
  }

  private json(entry: PanelMessage): string {
    return JSON.stringify(entry.payload.components.map((component) => component.toJSON()));
  }

  private renderHeader(profile: GuildConfiguration, channel: PanelChannel, messages: Readonly<Record<string, string>>): PanelMessage {
    const text = settingsText(profile.language);
    const contents = panelUnits(this.engine.registered()).flatMap((unit) => {
      const messageId = messages[firstMessageKey(unit)];
      return messageId
        ? [{ title: unitTitle(unit, text), url: `https://discord.com/channels/${profile.guildId}/${channel.id}/${messageId}` }]
        : [];
    });
    return {
      key: headerKey,
      payload: renderPanelHeader({
        ui: texts[profile.language],
        embedColor: profile.embedColor,
        ids: this.ids,
        lastChange: this.lastChanges.get(profile.guildId) ?? null,
        everyoneCanView: channel.permissionsFor(channel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) ?? false,
        contents,
      }),
    };
  }

  private async renderSections(profile: GuildConfiguration, channel: PanelChannel): Promise<PanelMessage[]> {
    const ui = texts[profile.language];
    const text = settingsText(profile.language);
    const reports = await this.runReports(profile, channel.guild);
    return panelUnits(this.engine.registered()).flatMap((unit) =>
      renderUnitMessages(unit, { profile, text, ui, ids: this.ids, reports }));
  }

  private async runReports(profile: GuildConfiguration, guild: Guild): Promise<Map<string, string>> {
    const reports = new Map<string, string>();
    for (const registered of this.engine.registered()) {
      if (registered.node.kind !== "report") continue;
      try {
        const result = await this.engine.run(registered, {
          guildId: profile.guildId,
          guild,
          actorUserId: this.client.user?.id ?? "",
          language: profile.language,
          values: panelValues({}),
        }, { kind: "panel" });
        if (result.kind === "report") reports.set(registered.path, result.text);
      } catch (error) {
        this.logger.warn({ err: error, guildId: profile.guildId, setting: registered.path }, "Admin panel report failed");
      }
    }
    return reports;
  }

  private missingPermissions(channel: PanelChannel): string[] {
    const me = channel.guild.members.me;
    const permissions = me ? channel.permissionsFor(me) : null;
    return requiredPermissions.filter((permission) => !permissions?.has(permission));
  }

  // Only the bot posts in the panel channel: @everyone may not send there,
  // and the bot's own overwrite keeps it able to. True when that's in
  // place (or the bot couldn't have done it and it's already so).
  private async lockChannel(channel: PanelChannel): Promise<boolean> {
    const me = channel.guild.members.me;
    if (!me) return false;
    const everyone = channel.permissionOverwrites.cache.get(channel.guild.roles.everyone.id);
    const own = channel.permissionOverwrites.cache.get(me.id);
    const locked = everyone?.deny.has(PermissionsBitField.Flags.SendMessages) === true &&
      own?.allow.has(PermissionsBitField.Flags.SendMessages) === true;
    if (locked) return true;
    if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageRoles)) return false;
    try {
      await channel.permissionOverwrites.edit(me, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false });
      return true;
    } catch (error) {
      this.logger.warn({ err: error, guildId: channel.guildId, channelId: channel.id }, "Could not lock the admin panel channel");
      return false;
    }
  }

  // Records the panel's health, noting a change in the audit log once.
  private async report(guildId: string, issues: readonly AdminPanelIssue[]): Promise<void> {
    const previous = this.health.get(guildId);
    if (!this.health.set(guildId, issues)) return;
    const language = this.profiles.find(guildId)?.language ?? "en";
    const health = texts[language].admin.panel.health;
    const lines = issues.map((issue) => {
      switch (issue.kind) {
        case "missing-permissions":
          return health.missingPermissions({ channel: `<#${issue.channelId}>`, permissions: issue.permissions.join(", ") });
        case "cannot-lock":
          return health.cannotLock({ channel: `<#${issue.channelId}>` });
        case "healing-paused":
          return health.healingPaused({ channel: `<#${issue.channelId}>` });
        case "channel-deleted":
          return health.channelDeleted;
      }
    });
    if (lines.length === 0 && previous.length > 0) lines.push(health.resolved);
    if (lines.length === 0) return;
    await this.auditLogService?.log(guildId, this.client.user?.id ?? "", `**${health.heading}**\n${lines.join("\n")}`)
      .catch((error: unknown) => this.logger.warn({ err: error, guildId }, "Could not audit-log admin panel health"));
  }

  private async fetchMessage(channel: PanelChannel, messageId: string): Promise<Message | null> {
    return channel.messages.cache.get(messageId) ?? await channel.messages.fetch(messageId).catch(() => null);
  }

  private async removeMessages(guildId: string, channelId: string, messageIds: readonly string[]): Promise<void> {
    if (messageIds.length === 0) return;
    const channel = await this.fetchPanelChannel(guildId, channelId);
    for (const messageId of messageIds) {
      this.written.delete(messageId);
      const message = channel ? await this.fetchMessage(channel, messageId) : null;
      if (!message) continue;
      this.deleting.add(messageId);
      await message.delete().catch((error: unknown) => {
        this.deleting.delete(messageId);
        this.logger.warn({ err: error, guildId, messageId }, "Failed to delete an admin panel message");
      });
    }
  }

  private async fetchPanelChannel(guildId: string, channelId: string): Promise<PanelChannel | null> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    // client.channels.fetch is global — a stale id from another guild's
    // config must never get this guild's settings posted into it.
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) ||
      channel.guildId !== guildId
    ) {
      return null;
    }
    return channel;
  }
}
