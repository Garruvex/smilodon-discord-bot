import {
  ChannelSelectMenuBuilder,
  ChannelType,
  CheckboxBuilder,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Attachment,
  type ModalSubmitFields,
} from "discord.js";

import type { SettingsText } from "../../../../application/i18n/settings/index.js";
import type { Texts } from "../../../../application/i18n/texts.js";
import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import { optionPath, type RegisteredNode } from "../registry/paths.js";
import type { ActionParam, SettingOption } from "../registry/types.js";
import type { ControlIds } from "./control-ids.js";
import { formOptionsOf, truncate } from "./node-rows.js";
import type { PanelInput, PanelScalar } from "./panel-values.js";

// Discord's caps on a modal.
const titleLimit = 45;
const labelLimit = 45;
const descriptionLimit = 100;
const selectTextLimit = 100;
const longTextThreshold = 200;
const textChannelTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

type FormField = SettingOption | ActionParam;

// A node's form: a setting's typed and upload options, pre-filled with
// their current values, or an action's parameters. Null when the node has
// nothing to fill in.
export function renderNodeForm(
  registered: RegisteredNode,
  profile: GuildConfiguration,
  text: SettingsText,
  ids: ControlIds,
): ModalBuilder | null {
  const fields = formFieldsOf(registered);
  if (fields.length === 0) return null;
  const modal = new ModalBuilder()
    .setCustomId(ids.encode({ kind: "form", path: registered.path }))
    .setTitle(truncate(text.label(registered.path), titleLimit));

  for (const [name, field] of fields) {
    const key = optionPath(registered.path, name);
    const label = new LabelBuilder()
      .setLabel(truncate(text.label(key), labelLimit))
      .setDescription(truncate(text.description(key), descriptionLimit));
    const current = registered.node.kind === "setting" && "read" in field ? field.read(profile) : null;
    const required = registered.node.kind !== "setting" && field.required === true;

    switch (field.kind) {
      case "integer":
      case "text": {
        const input = new TextInputBuilder()
          .setCustomId(name)
          .setStyle(field.kind === "text" && field.maxLength > longTextThreshold ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(required);
        if (field.kind === "text") input.setMaxLength(field.maxLength);
        if (typeof current === "string" || typeof current === "number") input.setValue(String(current));
        label.setTextInputComponent(input);
        break;
      }
      case "upload":
        label.setFileUploadComponent(new FileUploadBuilder().setCustomId(name).setMinValues(0).setMaxValues(1).setRequired(required));
        break;
      case "choice":
        label.setStringSelectMenuComponent(new StringSelectMenuBuilder()
          .setCustomId(name)
          .setRequired(required)
          .addOptions(field.choices.map((value) => ({ label: truncate(text.choice(key, value), selectTextLimit), value }))));
        break;
      case "channel": {
        const select = new ChannelSelectMenuBuilder().setCustomId(name).setRequired(required);
        if (field.textOnly) select.setChannelTypes(...textChannelTypes);
        label.setChannelSelectMenuComponent(select);
        break;
      }
      case "role":
        label.setRoleSelectMenuComponent(new RoleSelectMenuBuilder().setCustomId(name).setRequired(required));
        break;
      case "toggle":
        label.setCheckboxComponent(new CheckboxBuilder().setCustomId(name));
        break;
      case "channelList":
      case "roleList":
        continue;
    }
    modal.addLabelComponents(label);
  }
  return modal;
}

export type FormReadResult = { ok: true; input: PanelInput } | { ok: false; message: string };

// A submitted form as panel input. For a setting only fields the admin
// actually changed are passed on: an option can have side effects just for
// being given (an image URL replaces an uploaded image), so an untouched
// pre-filled field must look like an omitted slash option. An emptied field
// counts as untouched too.
export function readNodeForm(
  registered: RegisteredNode,
  profile: GuildConfiguration,
  text: SettingsText,
  ui: Texts,
  fields: ModalSubmitFields,
): FormReadResult {
  const scalars: Record<string, PanelScalar> = {};
  const files: Record<string, Attachment> = {};
  const isSetting = registered.node.kind === "setting";

  for (const [name, field] of formFieldsOf(registered)) {
    const key = optionPath(registered.path, name);
    const current = isSetting && "read" in field ? field.read(profile) : null;
    switch (field.kind) {
      case "integer":
      case "text": {
        const raw = optional(() => fields.getTextInputValue(name))?.trim() ?? "";
        if (raw === "") continue;
        let value: PanelScalar = raw;
        if (field.kind === "integer") {
          if (!/^-?\d+$/.test(raw)) return { ok: false, message: ui.settings.error.notInteger({ label: text.label(key) }) };
          value = Number.parseInt(raw, 10);
        }
        if (value !== current) scalars[name] = value;
        break;
      }
      case "upload": {
        const file = optional(() => fields.getUploadedFiles(name))?.first();
        if (file) files[name] = file;
        break;
      }
      case "choice": {
        const [value] = optional(() => fields.getStringSelectValues(name)) ?? [];
        if (value !== undefined) scalars[name] = value;
        break;
      }
      case "channel": {
        const id = optional(() => fields.getSelectedChannels(name))?.first()?.id;
        if (id !== undefined) scalars[name] = id;
        break;
      }
      case "role": {
        const id = optional(() => fields.getSelectedRoles(name))?.first()?.id;
        if (id !== undefined) scalars[name] = id;
        break;
      }
      case "toggle": {
        const checked = optional(() => fields.getCheckbox(name));
        if (checked !== null) scalars[name] = checked;
        break;
      }
      case "channelList":
      case "roleList":
        break;
    }
  }
  return { ok: true, input: { scalars, files } };
}

function formFieldsOf(registered: RegisteredNode): [string, FormField][] {
  switch (registered.node.kind) {
    case "setting":
      return formOptionsOf(registered.node);
    case "action":
      return Object.entries(registered.node.params);
    case "report":
      return [];
  }
}

// discord.js throws for a field the submit doesn't carry.
function optional<T>(read: () => T | null | undefined): T | null {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
}
