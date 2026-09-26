// Engine capabilities: mechanics the engine must implement before content
// that depends on them may ship. Most requirements are derived from a
// definition's shape (see requiredCapabilities in content-definitions.ts), so
// content authors cannot forget to declare them.

export const capabilities = [
  "attack-rolls",
  "saving-throws",
  "damage",
  "healing",
  "conditions",
  "bonus-dice",
  "spell-slots",
  "concentration",
  "death-saves",
] as const;
export type Capability = (typeof capabilities)[number];

// What milestone 0 commits to implementing (plan §12). Content tests build
// the shipped rulesets against this set so authoring can run ahead of the
// engine; startup will build against the engine's implemented set instead,
// and refuse to boot if content needs something the engine lacks.
export const milestone0Capabilities: ReadonlySet<Capability> = new Set(capabilities);
