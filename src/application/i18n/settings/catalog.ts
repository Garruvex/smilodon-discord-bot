import type { Language } from "../language.js";

// Text for one registered settings node, keyed in a catalog by its registry
// path ("music", "chat.abilities", "music.dj-mode", "music.dj-mode.enabled").
// Which fields a node needs depends on its level — see the settings
// registry's validation: groups and sections have a title, nodes and
// options a label, everything a description, choice options every choice.
export interface SettingsNodeText {
  title?: string;
  label?: string;
  description?: string;
  // Choice value → display name.
  choices?: Readonly<Record<string, string>>;
  // A setting's own messages (validation errors, confirmation notes), by
  // name. `{name}` placeholders are filled in by SettingsText.message.
  messages?: Readonly<Record<string, string>>;
}

export type SettingsTextCatalog = Readonly<Record<string, SettingsNodeText>>;

export type SettingsTextCatalogs = Readonly<Record<Language, SettingsTextCatalog>>;
