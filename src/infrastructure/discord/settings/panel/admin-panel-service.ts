import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type Message,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type NewsChannel,
  type TextChannel,
} from "discord.js";
import type { Logger } from "pino";

import { KeyedSerialQueue } from "../../../../application/concurrency/keyed-serial-queue.js";
import { settingsText } from "../../../../application/i18n/settings/index.js";
import { texts } from "../../../../application/i18n/texts.js";
import type { AdminPanelStateStore } from "../../../../application/settings/admin-panel-state-store.js";
import type { AppliedSettingsChange, SettingsUpdateService } from "../../../../application/settings/settings-update-service.js";
import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import type { SettingsEngine } from "../engine/settings-engine.js";
import { controlIds } from "./control-ids.js";
import { replyWithResult, SettingsControlHandler, type ControlOutcome } from "./control-handler.js";
import {
  panelUnits,
  renderPanelHeader,
  renderUnitMessages,
  type PanelLastChange,
  type PanelMessage,
} from "./panel-messages.js";
import { panelValues } from "./panel-values.js";

type PanelChannel = TextChannel | NewsChannel;

export const adminPanelPrefix = "adm";
const headerKey = "header";
const lastChangeSummaryLimit = 200;

// The admin panel: a header plus one message per settings section in the
// guild's channels.adminPanel, kept in sync with the config. It's a surface
// of SettingsEngine like the /settings-* commands — every control runs the
// same setting through the same engine — and every write, from any surface,
// redraws it through the update service's change listener.
export class AdminPanelService {
  private readonly ids = controlIds(adminPanelPrefix);
  private readonly controls: SettingsControlHandler;
  private readonly queue = new KeyedSerialQueue();
  private readonly lastChanges = new Map<string, PanelLastChange>();
  // messageId → the rendered JSON last written to it, so a refresh only
  // edits messages whose content actually changed.
  private readonly written = new Map<string, string>();

  public constructor(
    private readonly client: Client,
    private readonly profiles: GuildConfigurationProvider,
    private readonly engine: SettingsEngine,
    updater: SettingsUpdateService,
    private readonly store: AdminPanelStateStore,
    private readonly logger: Logger,
  ) {
    this.controls = new SettingsControlHandler(engine, profiles, this.ids, { kind: "panel" });
    // Not awaited: a slow redraw mustn't hold up the reply to the change.
    updater.addListener((change) => {
      this.handleSettingsChange(change);
      return Promise.resolve();
    });
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

  private async writePanel(guildId: string, force: ((key: string) => boolean) | "all"): Promise<void> {
    const profile = this.profiles.find(guildId);
    const state = this.store.find(guildId);
    const channelId = profile?.channels.adminPanel ?? null;

    // Moved or turned off: take the old panel down first.
    if (state && state.channelId !== channelId) {
      await this.removeMessages(guildId, state.channelId, Object.values(state.messages));
      await this.store.delete(guildId);
    }
    if (!profile || !channelId) return;

    const channel = await this.fetchPanelChannel(guildId, channelId);
    if (!channel) {
      this.logger.warn({ guildId, channelId }, "Admin panel channel is missing or not a text channel");
      return;
    }

    const messages: Record<string, string> = { ...(this.store.find(guildId)?.messages ?? {}) };
    const desired = await this.renderAll(profile, channel);
    for (const entry of desired) {
      const json = JSON.stringify(entry.payload.components.map((component) => component.toJSON()));
      const existing = messages[entry.key] ? await this.fetchMessage(channel, messages[entry.key]!) : null;
      if (existing) {
        const forced = force === "all" || force(entry.key);
        if (forced || this.written.get(existing.id) !== json) await existing.edit(entry.payload);
        this.written.set(existing.id, json);
      } else {
        const sent = await channel.send(entry.payload);
        messages[entry.key] = sent.id;
        this.written.set(sent.id, json);
      }
    }

    // A section that shrank, or a setting that was removed.
    const wanted = new Set(desired.map((entry) => entry.key));
    const leftover = Object.entries(messages).filter(([key]) => !wanted.has(key));
    await this.removeMessages(guildId, channelId, leftover.map(([, id]) => id));
    for (const [key] of leftover) delete messages[key];

    await this.store.save({ guildId, channelId, messages });
  }

  private async renderAll(profile: GuildConfiguration, channel: PanelChannel): Promise<PanelMessage[]> {
    const ui = texts[profile.language];
    const text = settingsText(profile.language);
    const reports = await this.runReports(profile, channel.guild);
    const header: PanelMessage = {
      key: headerKey,
      payload: renderPanelHeader({
        ui,
        embedColor: profile.embedColor,
        ids: this.ids,
        lastChange: this.lastChanges.get(profile.guildId) ?? null,
        everyoneCanView: channel.permissionsFor(channel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) ?? false,
      }),
    };
    return [
      header,
      ...panelUnits(this.engine.registered()).flatMap((unit) =>
        renderUnitMessages(unit, { profile, text, ui, ids: this.ids, reports })),
    ];
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

  private async fetchMessage(channel: PanelChannel, messageId: string): Promise<Message | null> {
    return channel.messages.cache.get(messageId) ?? await channel.messages.fetch(messageId).catch(() => null);
  }

  private async removeMessages(guildId: string, channelId: string, messageIds: readonly string[]): Promise<void> {
    if (messageIds.length === 0) return;
    const channel = await this.fetchPanelChannel(guildId, channelId);
    for (const messageId of messageIds) {
      this.written.delete(messageId);
      const message = channel ? await this.fetchMessage(channel, messageId) : null;
      await message?.delete().catch((error: unknown) => {
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
