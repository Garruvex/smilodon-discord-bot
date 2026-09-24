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

import { KeyedSerialQueue } from "../../../application/concurrency/keyed-serial-queue.js";
import type { AppliedSettingsChange } from "../../../application/settings/settings-update-service.js";
import type { GuildConfiguration } from "../../../config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import type { SettingValues } from "../settings/definitions/index.js";
import { buildPanelLayout, type PanelSectionLayout, type PanelSettingRow } from "../settings/panel-layout.js";
import { panelValues } from "../settings/panel-values.js";
import type { SettingRunResult, SettingsEngine } from "../settings/settings-engine.js";
import { parseAdminPanelId, type AdminPanelAction } from "./admin-panel-ids.js";
import { readAdminPanelModal } from "./admin-panel-modal-input.js";
import {
  renderAdminPanelHeader,
  renderAdminPanelModal,
  renderAdminPanelSection,
  type AdminPanelLastChange,
  type AdminPanelPayload,
} from "./admin-panel-renderer.js";
import { adminPanelText, type AdminPanelText } from "./admin-panel-text.js";

type PanelChannel = TextChannel | NewsChannel;

const headerKey = "header";
// Panel messages are found by scanning this many recent messages — the
// channel is meant to hold nothing but the panel.
const scanLimit = 50;
const lastChangeSummaryLimit = 200;

// The admin panel: one message per settings section in the guild's
// channels.adminPanel, kept in sync with the config. It's the second
// surface of SettingsEngine (the /settings-* commands are the first) — every
// control turns into option values and runs the same setting through the
// same engine, and every write from either surface redraws the panel
// through the engine's change listener.
export class AdminPanelService {
  private readonly layout: readonly PanelSectionLayout[] = buildPanelLayout();
  private readonly queue = new KeyedSerialQueue();
  private readonly lastChanges = new Map<string, AdminPanelLastChange>();
  // messageId → the rendered JSON last written to it, so a refresh only
  // edits messages whose content actually changed.
  private readonly written = new Map<string, string>();

  public constructor(
    private readonly client: Client,
    private readonly profiles: GuildConfigurationProvider,
    private readonly engine: SettingsEngine,
    private readonly logger: Logger,
  ) {
    engine.addChangeListener((change) => this.handleSettingsChange(change));
  }

  public initialize(): void {
    for (const profile of this.profiles.getAll()) {
      if (profile.channels.adminPanel) void this.refresh(profile.guildId);
    }
  }

  // Redraws the guild's panel, creating it if needed. `force` re-edits
  // messages even when their content hasn't changed (resetting a select a
  // user changed locally when the change was refused).
  public refresh(guildId: string, force: ReadonlySet<string> | "all" = new Set()): Promise<void> {
    return this.queue.run(guildId, async () => {
      try {
        await this.writePanel(guildId, force);
      } catch (error) {
        this.logger.error({ err: error, guildId }, "Admin panel refresh failed");
      }
    });
  }

  public async handleComponent(interaction: MessageComponentInteraction): Promise<void> {
    const action = parseAdminPanelId(interaction.customId);
    if (!action || !interaction.inCachedGuild()) {
      await this.replyStale(interaction);
      return;
    }
    const guildId = interaction.guildId;

    if (action.kind === "refresh") {
      await interaction.deferUpdate();
      await this.refresh(guildId, "all");
      return;
    }

    if (action.kind === "edit") {
      const row = this.findModalRow(action.section, action.setting);
      if (!row) {
        await this.replyStale(interaction);
        return;
      }
      const profile = this.profiles.require(guildId);
      await interaction.showModal(renderAdminPanelModal(row.section, row.row, profile, this.textFor(profile)));
      return;
    }

    if (action.kind === "modal") return;

    const target = this.findOption(action.setting, action.option);
    if (!target) {
      await this.replyStale(interaction);
      return;
    }
    const values = this.componentValues(action, interaction);
    if (!values) {
      await this.replyStale(interaction);
      return;
    }

    await interaction.deferUpdate();
    const outcome = await this.runSetting(target.row, target.section, interaction.guild, interaction.user.id, values);
    if (outcome.reply) {
      await interaction.followUp({ content: outcome.reply, flags: MessageFlags.Ephemeral });
      // The select may still show what the admin picked; put it back.
      await this.refresh(guildId, new Set([target.section.name]));
    }
  }

  public async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const action = parseAdminPanelId(interaction.customId);
    const row = action?.kind === "modal" ? this.findModalRow(action.section, action.setting) : null;
    if (!row || !interaction.inCachedGuild()) {
      await interaction.reply({ content: this.textFor(null).ui.stale, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const profile = this.profiles.require(interaction.guildId);
    const text = this.textFor(profile);
    const input = readAdminPanelModal(row.row, profile, text, (field) => interaction.fields.getTextInputValue(field));
    if (!input.ok) {
      await interaction.editReply(input.message);
      return;
    }
    if (Object.keys(input.scalars).length === 0) {
      await interaction.editReply(text.ui.noChanges);
      return;
    }

    const outcome = await this.runSetting(
      row.row, row.section, interaction.guild, interaction.user.id, panelValues(input.scalars),
    );
    await interaction.editReply(outcome.reply ?? outcome.description ?? text.ui.noChanges);
  }

  // Runs one panel change through the engine. `reply` is set when the admin
  // needs telling (refused or failed); `description` is the engine's
  // confirmation for surfaces that show one (the modal).
  private async runSetting(
    row: PanelSettingRow,
    section: PanelSectionLayout,
    guild: Guild,
    actorUserId: string,
    values: SettingValues,
  ): Promise<{ reply?: string; description?: string }> {
    const text = this.textFor(this.profiles.find(guild.id));
    let result: SettingRunResult;
    try {
      result = await this.engine.run(
        row.setting,
        { guildId: guild.id, guild, actorUserId, values },
        { kind: "panel", section: section.title },
      );
    } catch (error) {
      this.logger.warn({ err: error, guildId: guild.id, setting: row.setting.name }, "Admin panel change failed");
      const reason = error instanceof Error ? error.message : String(error);
      return { reply: text.ui.failed({ reason: reason.slice(0, 500) }) };
    }
    switch (result.kind) {
      case "rejected":
        return { reply: result.message };
      case "updated":
        return { description: result.description };
      case "empty":
      case "report":
        return {};
    }
  }

  private componentValues(action: AdminPanelAction, interaction: MessageComponentInteraction): SettingValues | null {
    switch (action.kind) {
      case "toggle":
        return panelValues({ [action.option]: action.value });
      case "choice":
      case "channel":
      case "role": {
        if (!interaction.isAnySelectMenu()) return null;
        const [value] = interaction.values;
        return value === undefined ? null : panelValues({ [action.option]: value });
      }
      case "list":
        return interaction.isAnySelectMenu() ? panelValues({}, { [action.option]: interaction.values }) : null;
      default:
        return null;
    }
  }

  private async handleSettingsChange(change: AppliedSettingsChange): Promise<void> {
    this.lastChanges.set(change.guildId, {
      summary: summarizeChange(change.description),
      userId: change.actorUserId,
      at: new Date(),
    });
    const previousChannel = change.previous.channels.adminPanel;
    if (previousChannel && previousChannel !== change.updated.channels.adminPanel) {
      await this.queue.run(change.guildId, () => this.removePanel(change.guildId, previousChannel))
        .catch((error: unknown) => {
          this.logger.warn({ err: error, guildId: change.guildId }, "Failed to remove the old admin panel");
        });
    }
    await this.refresh(change.guildId);
  }

  private async writePanel(guildId: string, force: ReadonlySet<string> | "all"): Promise<void> {
    const profile = this.profiles.find(guildId);
    const channelId = profile?.channels.adminPanel;
    if (!profile || !channelId) return;
    const channel = await this.fetchPanelChannel(guildId, channelId);
    if (!channel) {
      this.logger.warn({ guildId, channelId }, "Admin panel channel is missing or not a text channel");
      return;
    }

    const desired = await this.renderAll(profile, channel);
    const existing = await this.findPanelMessages(channel);

    // Edit in place only when every message exists once and in order;
    // otherwise repost the whole panel so it reads top to bottom.
    const inPlace = desired.every((entry, index) => {
      const found = existing.get(entry.key);
      if (found?.length !== 1) return false;
      const previous = index === 0 ? undefined : existing.get(desired[index - 1]!.key)?.[0];
      return !previous || BigInt(previous.id) < BigInt(found[0]!.id);
    });

    if (!inPlace) {
      for (const messages of existing.values()) {
        for (const message of messages) await this.deleteQuietly(message);
      }
      for (const entry of desired) {
        const message = await channel.send(entry.payload);
        this.written.set(message.id, entry.json);
      }
      return;
    }

    for (const entry of desired) {
      const message = existing.get(entry.key)![0]!;
      const isForced = force === "all" || force.has(entry.key);
      if (!isForced && this.written.get(message.id) === entry.json) continue;
      await message.edit(entry.payload);
      this.written.set(message.id, entry.json);
    }
  }

  private async renderAll(
    profile: GuildConfiguration,
    channel: PanelChannel,
  ): Promise<{ key: string; payload: AdminPanelPayload; json: string }[]> {
    const text = this.textFor(profile);
    const everyone = channel.guild.roles.everyone;
    const payloads: { key: string; payload: AdminPanelPayload }[] = [{
      key: headerKey,
      payload: renderAdminPanelHeader({
        text,
        embedColor: profile.embedColor,
        lastChange: this.lastChanges.get(profile.guildId) ?? null,
        everyoneCanView: channel.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel) ?? false,
      }),
    }];
    for (const section of this.layout) {
      payloads.push({
        key: section.name,
        payload: renderAdminPanelSection({
          section,
          profile,
          text,
          reports: await this.runReports(section, profile, channel.guild),
        }),
      });
    }
    return payloads.map((entry) => ({
      ...entry,
      json: JSON.stringify(entry.payload.components.map((component) => component.toJSON())),
    }));
  }

  private async runReports(section: PanelSectionLayout, profile: GuildConfiguration, guild: Guild): Promise<Map<string, string>> {
    const reports = new Map<string, string>();
    for (const row of section.rows) {
      if (row.kind !== "report") continue;
      try {
        const result = await this.engine.run(
          row.setting,
          { guildId: profile.guildId, guild, actorUserId: this.client.user?.id ?? "", values: panelValues({}) },
          { kind: "panel", section: section.title },
        );
        if (result.kind === "report" && typeof result.reply === "string") reports.set(row.setting.name, result.reply);
      } catch (error) {
        this.logger.warn({ err: error, guildId: profile.guildId, setting: row.setting.name }, "Admin panel report failed");
      }
    }
    return reports;
  }

  // Bot-authored panel messages in the channel, grouped by header/section
  // key, oldest first.
  private async findPanelMessages(channel: PanelChannel): Promise<Map<string, Message[]>> {
    const found = new Map<string, Message[]>();
    const messages = await channel.messages.fetch({ limit: scanLimit });
    const sorted = [...messages.values()]
      .filter((message) => message.author.id === this.client.user?.id)
      .sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1));
    for (const message of sorted) {
      const key = this.panelKeyOf(message);
      if (!key) continue;
      found.set(key, [...(found.get(key) ?? []), message]);
    }
    return found;
  }

  private panelKeyOf(message: Message): string | null {
    for (const customId of collectCustomIds(message.components.map((component) => component.toJSON()))) {
      const action = parseAdminPanelId(customId);
      if (!action) continue;
      if (action.kind === "refresh") return headerKey;
      if (action.kind === "edit" || action.kind === "modal") return action.section;
      const target = this.findOption(action.setting, action.option);
      if (target) return target.section.name;
    }
    return null;
  }

  private async removePanel(guildId: string, channelId: string): Promise<void> {
    const channel = await this.fetchPanelChannel(guildId, channelId);
    if (!channel) return;
    for (const messages of (await this.findPanelMessages(channel)).values()) {
      for (const message of messages) await this.deleteQuietly(message);
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

  private findOption(settingName: string, optionName: string): { section: PanelSectionLayout; row: PanelSettingRow } | null {
    for (const section of this.layout) {
      for (const row of section.rows) {
        if (row.kind !== "setting" || row.setting.name !== settingName) continue;
        const options = [...row.controls.map((control) => control.option.name), ...row.modalFields.map((option) => option.name)];
        if (options.includes(optionName)) return { section, row };
      }
    }
    return null;
  }

  private findModalRow(sectionName: string, settingName: string): { section: PanelSectionLayout; row: PanelSettingRow } | null {
    const section = this.layout.find((candidate) => candidate.name === sectionName);
    const row = section?.rows.find((candidate): candidate is PanelSettingRow =>
      candidate.kind === "setting" && candidate.setting.name === settingName && candidate.modalFields.length > 0);
    return section && row ? { section, row } : null;
  }

  private textFor(profile: GuildConfiguration | null): AdminPanelText {
    return adminPanelText(profile?.language ?? "en");
  }

  private async replyStale(interaction: MessageComponentInteraction): Promise<void> {
    await interaction.reply({ content: this.textFor(null).ui.stale, flags: MessageFlags.Ephemeral });
    if (interaction.guildId) await this.refresh(interaction.guildId, "all");
  }

  private async deleteQuietly(message: Message): Promise<void> {
    this.written.delete(message.id);
    await message.delete().catch((error: unknown) => {
      this.logger.warn({ err: error, messageId: message.id }, "Failed to delete an admin panel message");
    });
  }
}

// "Server settings updated.\nDJ mode enabled: false → true" → the changed
// lines, for the header's "Last change" line.
export function summarizeChange(description: string): string {
  const lines = description.split("\n").map((line) => line.trim()).filter(Boolean);
  const changed = lines[0] === "Server settings updated." ? lines.slice(1) : lines;
  const summary = changed.slice(0, 2).join("; ");
  return summary.length <= lastChangeSummaryLimit ? summary : `${summary.slice(0, lastChangeSummaryLimit - 1)}…`;
}

function collectCustomIds(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(collectCustomIds);
  if (!node || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const own = typeof record.custom_id === "string" ? [record.custom_id] : [];
  return [...own, ...collectCustomIds(record.components), ...collectCustomIds(record.accessory)];
}
