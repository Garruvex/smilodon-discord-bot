import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  SeparatorBuilder,
  TextDisplayBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type OverwriteResolvable,
} from "discord.js";
import type { Logger } from "pino";

import { settingsText } from "../../../../application/i18n/settings/index.js";
import { texts } from "../../../../application/i18n/texts.js";
import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import type { SettingsEngine } from "../engine/settings-engine.js";
import { controlIds } from "../panel/control-ids.js";
import { replyWithResult, SettingsControlHandler, type ControlOutcome } from "../panel/control-handler.js";
import { renderNodeBlock } from "../panel/node-rows.js";
import { accentColor } from "../panel/panel-messages.js";
import { panelValues } from "../panel/panel-values.js";
import type { RegisteredNode } from "../registry/paths.js";

export const setupGuidePrefix = "wiz";

// The guide opens on the language, so the rest of it (and the panel) reads in
// the language picked, then asks for the panel's channel, so everything it
// skips has a home.
const panelChannelPath = "access.admin-panel";
const languagePath = "community.language";

type Surface = MessageComponentInteraction<"cached"> | ModalSubmitInteraction<"cached">;

// Where a guild is in the guide. In memory: after a restart /setup guide
// starts over, showing the values already chosen.
interface Session {
  step: number;
  // Steps where something changed, whose button reads Next rather than Skip.
  changed: Set<number>;
}

// /setup guide: a private walkthrough of the settings marked `setup`, one
// at a time. Each step is the admin panel's own row for that setting, run
// through the same engine (audited as guided setup), with Back, Skip or
// Next, and Finish later. Custom ids are `wiz:<step>:…`: a setting's
// controls use controlIds("wiz:<step>"), the guide's own buttons use
// go / later / finish / create.
export class SetupGuide {
  private readonly sessions = new Map<string, Session>();

  public constructor(
    private readonly engine: SettingsEngine,
    private readonly profiles: GuildConfigurationProvider,
    private readonly logger: Logger,
  ) {}

  // The steps: the language, the panel channel, then every other setting
  // marked for setup in registry order.
  public steps(): RegisteredNode[] {
    const first = [languagePath, panelChannelPath].flatMap((path) => this.engine.find(path) ?? []);
    const rest = this.engine.registered().filter((registered) =>
      registered.node.kind === "setting" && registered.node.setup === true && !first.includes(registered));
    return [...first, ...rest];
  }

  public async start(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
    const profile = this.profiles.find(interaction.guildId);
    if (!profile) {
      await interaction.reply({ content: texts.en.setup.guide.notConfigured, flags: MessageFlags.Ephemeral });
      return;
    }
    const session = this.session(interaction.guildId);
    await interaction.reply({
      components: this.render(profile, session.step),
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    });
  }

  public async handleComponent(interaction: MessageComponentInteraction): Promise<void> {
    if (!interaction.inCachedGuild()) return;
    const parsed = this.parse(interaction.customId);
    const profile = this.profiles.find(interaction.guildId);
    if (!parsed || !profile) return;
    const { step, code, argument } = parsed;
    const ui = texts[profile.language].setup.guide;
    const session = this.session(interaction.guildId);

    switch (code) {
      case "go": {
        const target = Number(argument);
        if (!Number.isInteger(target) || target < 0 || target > this.steps().length) return;
        session.step = target;
        await interaction.update({ components: this.render(profile, target) });
        return;
      }
      case "later":
        session.step = step;
        await interaction.update({ components: [notice(profile, ui.later)] });
        return;
      case "finish":
        this.sessions.delete(interaction.guildId);
        await interaction.update({ components: [notice(profile, ui.finished)] });
        return;
      case "create":
        await interaction.deferUpdate();
        await this.createPanelChannel(interaction, step);
        return;
    }
    await this.afterControl(interaction, step, await this.controls(step).handleComponent(interaction));
  }

  public async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.inCachedGuild()) return;
    const parsed = this.parse(interaction.customId);
    if (!parsed) return;
    await this.afterControl(interaction, parsed.step, await this.controls(parsed.step).handleForm(interaction));
  }

  private controls(step: number): SettingsControlHandler {
    return new SettingsControlHandler(this.engine, this.profiles, controlIds(`${setupGuidePrefix}:${step}`), { kind: "setup" });
  }

  private async afterControl(interaction: Surface, step: number, outcome: ControlOutcome): Promise<void> {
    const profile = this.profiles.require(interaction.guildId);
    const ui = texts[profile.language];
    switch (outcome.kind) {
      case "opened":
      case "refresh":
        return;
      case "stale":
        await interaction.reply({ content: ui.admin.panel.stale, flags: MessageFlags.Ephemeral });
        return;
      case "ran":
        if (outcome.result.kind === "updated" || outcome.result.kind === "done") this.session(interaction.guildId).changed.add(step);
        await replyWithResult(interaction, outcome, ui);
        // Redraw the step: it shows the new value (or undoes a refused pick),
        // and a changed language re-renders the whole guide in it.
        await interaction.editReply({ components: this.render(this.profiles.require(interaction.guildId), step) });
    }
  }

  // A channel only bot admins (and the bot) can see, made the panel's home.
  private async createPanelChannel(interaction: MessageComponentInteraction<"cached">, step: number): Promise<void> {
    const profile = this.profiles.require(interaction.guildId);
    const ui = texts[profile.language].setup.guide;
    const registered = this.engine.find(panelChannelPath);
    if (!registered) return;
    let channelId: string;
    try {
      const channel = await interaction.guild.channels.create({
        name: ui.channelName,
        type: ChannelType.GuildText,
        permissionOverwrites: privateOverwrites(interaction.guild, profile),
      });
      channelId = channel.id;
    } catch (error) {
      this.logger.warn({ err: error, guildId: interaction.guildId }, "Could not create the admin panel channel");
      await interaction.followUp({
        content: ui.createFailed({ reason: error instanceof Error ? error.message : String(error) }),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const result = await this.engine.run(registered, {
      guildId: interaction.guildId,
      guild: interaction.guild,
      actorUserId: interaction.user.id,
      language: profile.language,
      values: panelValues({ scalars: { channel: channelId } }),
    }, { kind: "setup" });
    const next = result.kind === "rejected" ? step : step + 1;
    if (result.kind === "rejected") {
      await interaction.followUp({ content: result.message, flags: MessageFlags.Ephemeral });
    }
    const session = this.session(interaction.guildId);
    session.changed.add(step);
    session.step = next;
    await interaction.editReply({ components: this.render(this.profiles.require(interaction.guildId), next) });
  }

  private session(guildId: string): Session {
    let session = this.sessions.get(guildId);
    if (!session) {
      session = { step: 0, changed: new Set() };
      this.sessions.set(guildId, session);
    }
    return session;
  }

  private parse(customId: string): { step: number; code: string; argument: string | undefined } | null {
    const [prefix, stepText, code, argument] = customId.split(":");
    const step = Number(stepText);
    if (prefix !== setupGuidePrefix || !Number.isInteger(step) || step < 0 || code === undefined) return null;
    return { step, code, argument };
  }

  private render(profile: GuildConfiguration, step: number): ContainerBuilder[] {
    const steps = this.steps();
    const ui = texts[profile.language];
    const guide = ui.setup.guide;
    const text = settingsText(profile.language);
    const nav = (code: string, argument?: number): string =>
      [setupGuidePrefix, step, code, ...(argument === undefined ? [] : [argument])].join(":");
    const back = new ButtonBuilder().setCustomId(nav("go", step - 1)).setStyle(ButtonStyle.Secondary).setLabel(guide.back);
    const container = new ContainerBuilder().setAccentColor(accentColor(profile.embedColor));

    const registered = steps[step];
    if (!registered) {
      const channelId = profile.channels.adminPanel;
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        channelId ? guide.done({ channel: `<#${channelId}>` }) : guide.doneWithoutPanel,
      ));
      container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...(step > 0 ? [back] : []),
        new ButtonBuilder().setCustomId(nav("finish")).setStyle(ButtonStyle.Success).setLabel(guide.finish),
      ));
      return [container];
    }

    const heading = [
      `-# ${guide.step({ step: step + 1, total: steps.length, group: text.title(registered.group.name) })}`,
      ...(step === 0 ? [guide.intro] : []),
    ].join("\n");
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(heading));
    renderNodeBlock(registered, {
      profile,
      text,
      ui,
      ids: controlIds(`${setupGuidePrefix}:${step}`),
    }).add(container);
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${guide.hint}`));

    const changed = this.session(profile.guildId).changed.has(step);
    container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...(step > 0 ? [back] : []),
      new ButtonBuilder()
        .setCustomId(nav("go", step + 1))
        .setStyle(changed ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setLabel(changed ? guide.next : guide.skip),
      new ButtonBuilder().setCustomId(nav("later")).setStyle(ButtonStyle.Secondary).setLabel(guide.finishLater),
      ...(registered.path === panelChannelPath
        ? [new ButtonBuilder().setCustomId(nav("create")).setStyle(ButtonStyle.Success).setLabel(guide.createChannel)]
        : []),
    ));
    return [container];
  }
}

function notice(profile: GuildConfiguration, content: string): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(accentColor(profile.embedColor))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
}

// Hidden from everyone but the bot admins and the bot, which can post there.
function privateOverwrites(guild: Guild, profile: GuildConfiguration): OverwriteResolvable[] {
  const view = PermissionFlagsBits.ViewChannel;
  return [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [view] },
    ...[...profile.roles.botAdministrator].map((id): OverwriteResolvable => ({ id, type: OverwriteType.Role, allow: [view] })),
    ...(guild.members.me
      ? [{
        id: guild.members.me.id,
        type: OverwriteType.Member,
        allow: [view, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      } satisfies OverwriteResolvable]
      : []),
  ];
}
