// A translated set of slash-command descriptions, keyed by the command's
// path — see commandDescriptionKey. Anything missing from a catalog simply
// falls back to the English description Discord already has.
export type CommandDescriptionCatalog<Keys extends string = string> = Readonly<Record<Keys, string>>;

// "birthday" (a command), "birthday/set" (a subcommand),
// "settings-chat/chatbot" (a subcommand of a settings group) and
// "birthday/set:month" (an option, after the ":") are all keys. A
// subcommand group adds one more "/" segment.
export function commandDescriptionKey(
  path: readonly string[],
  optionName?: string,
): string {
  const base = path.join("/");
  return optionName === undefined ? base : `${base}:${optionName}`;
}
