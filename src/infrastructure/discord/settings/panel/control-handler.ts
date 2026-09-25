import {
  ActionRowBuilder,
  type AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from "discord.js";

import { settingsText } from "../../../../application/i18n/settings/index.js";
import { texts, type Texts } from "../../../../application/i18n/texts.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import type { SettingRequest, SettingValues } from "../engine/request.js";
import type { SettingRunResult, SettingSource, SettingsEngine } from "../engine/settings-engine.js";
import type { RegisteredNode } from "../registry/paths.js";
import type { ControlAction, ControlIds } from "./control-ids.js";
import { readNodeForm, renderNodeForm } from "./node-form.js";
import { panelValues } from "./panel-values.js";

// What a control did, for the surface to finish: redraw its message and
// tell the admin the outcome (see replyWithResult).
export type ControlOutcome =
  // A form or confirmation was opened; nothing ran yet.
  | { kind: "opened" }
  // The panel's Refresh button (already acknowledged).
  | { kind: "refresh" }
  // The id didn't match a registered setting — an old message.
  | { kind: "stale" }
  // A setting or action ran. `via` says how the admin should hear about it.
  | { kind: "ran"; result: SettingRunResult; via: "control" | "form" | "confirm" };

// The settings controls shared by the admin panel and guided setup: turns a
// button, select or form into option values and runs the setting through
// the engine — the same path as the slash command — then leaves redrawing
// to the surface. Every interaction is acknowledged before the engine runs,
// so a slow save can't outlast Discord's 3-second window.
export class SettingsControlHandler {
  public constructor(
    private readonly engine: SettingsEngine,
    private readonly profiles: GuildConfigurationProvider,
    private readonly ids: ControlIds,
    private readonly source: SettingSource,
  ) {}

  public async handleComponent(interaction: MessageComponentInteraction<"cached">): Promise<ControlOutcome> {
    const action = this.ids.parse(interaction.customId);
    if (!action) return { kind: "stale" };
    if (action.kind === "refresh") {
      await interaction.deferUpdate();
      return { kind: "refresh" };
    }
    const registered = this.engine.find(action.path);
    if (!registered) return { kind: "stale" };

    switch (action.kind) {
      case "edit":
        return this.openForm(interaction, registered);
      case "run":
        if (registered.node.kind === "action" && Object.keys(registered.node.params).length > 0) {
          return this.openForm(interaction, registered);
        }
        if (registered.node.kind === "action" && registered.node.confirm) {
          await this.askToConfirm(interaction, registered);
          return { kind: "opened" };
        }
        await interaction.deferUpdate();
        return this.ran(interaction, registered, panelValues({}), "control");
      case "confirm":
        await interaction.deferUpdate();
        return this.ran(interaction, registered, panelValues({}), "confirm");
      case "form":
        return { kind: "stale" };
      default: {
        const values = componentValues(action, interaction);
        if (!values) return { kind: "stale" };
        await interaction.deferUpdate();
        return this.ran(interaction, registered, values, "control");
      }
    }
  }

  public async handleForm(interaction: ModalSubmitInteraction<"cached">): Promise<ControlOutcome> {
    const action = this.ids.parse(interaction.customId);
    const registered = action?.kind === "form" ? this.engine.find(action.path) : undefined;
    if (!registered) return { kind: "stale" };

    const profile = this.profiles.require(interaction.guildId);
    const read = readNodeForm(registered, profile, settingsText(profile.language), texts[profile.language], interaction.fields);
    if (!read.ok) {
      await interaction.reply({ content: read.message, flags: MessageFlags.Ephemeral });
      return { kind: "opened" };
    }
    await interaction.deferUpdate();
    return this.ran(interaction, registered, panelValues(read.input), "form");
  }

  private async openForm(interaction: MessageComponentInteraction<"cached">, registered: RegisteredNode): Promise<ControlOutcome> {
    const profile = this.profiles.require(interaction.guildId);
    const form = renderNodeForm(registered, profile, settingsText(profile.language), this.ids);
    if (!form) return { kind: "stale" };
    await interaction.showModal(form);
    return { kind: "opened" };
  }

  private async askToConfirm(interaction: MessageComponentInteraction<"cached">, registered: RegisteredNode): Promise<void> {
    const profile = this.profiles.require(interaction.guildId);
    const ui = texts[profile.language].admin.panel;
    await interaction.reply({
      content: ui.confirm({ setting: settingsText(profile.language).label(registered.path) }),
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
        .setCustomId(this.ids.encode({ kind: "confirm", path: registered.path }))
        .setStyle(ButtonStyle.Danger)
        .setLabel(ui.confirmButton))],
      flags: MessageFlags.Ephemeral,
    });
  }

  private async ran(
    interaction: MessageComponentInteraction<"cached"> | ModalSubmitInteraction<"cached">,
    registered: RegisteredNode,
    values: SettingValues,
    via: "control" | "form" | "confirm",
  ): Promise<ControlOutcome> {
    const profile = this.profiles.require(interaction.guildId);
    const request: SettingRequest = {
      guildId: interaction.guildId,
      guild: interaction.guild,
      actorUserId: interaction.user.id,
      language: profile.language,
      values,
    };
    return { kind: "ran", result: await this.engine.run(registered, request, this.source), via };
  }
}

function componentValues(action: ControlAction, interaction: MessageComponentInteraction): SettingValues | null {
  if (action.kind === "toggle") return panelValues({ scalars: { [action.option]: action.value } });
  if (!interaction.isAnySelectMenu()) return null;
  switch (action.kind) {
    case "choice":
    case "channel":
    case "role": {
      const [value] = interaction.values;
      // An emptied single-channel picker clears a clearable channel.
      return value === undefined
        ? panelValues({ lists: { [action.option]: [] } })
        : panelValues({ scalars: { [action.option]: value } });
    }
    case "list":
      return panelValues({ lists: { [action.option]: interaction.values } });
    default:
      return null;
  }
}

// Tells the admin how a control went, privately: refusals always; for a
// form, its confirmation; for an action, its message and any files. A plain
// toggle or select needs no reply — the redrawn row shows the change.
export async function replyWithResult(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  outcome: Extract<ControlOutcome, { kind: "ran" }>,
  ui: Texts,
): Promise<void> {
  const { result, via } = outcome;
  let content: string | null;
  let files: readonly AttachmentBuilder[] = [];
  switch (result.kind) {
    case "rejected":
      content = result.message;
      break;
    case "report":
      content = result.text;
      break;
    case "done":
      content = result.message;
      files = result.files;
      break;
    case "updated":
      content = via === "control" ? null : result.description;
      break;
    case "empty":
      content = via === "control" ? null : ui.settings.noChanges;
      break;
  }
  if (content === null) return;
  if (via === "confirm") {
    await interaction.editReply({ content, components: [], files: [...files] });
    return;
  }
  await interaction.followUp({ content, files: [...files], flags: MessageFlags.Ephemeral });
}
