import { parse as parseYaml } from "yaml";

import { guildConfigurationFileSchema } from "./guild-configuration-schema.js";

export interface GuildConfigurationValidationResult {
  valid: boolean;
  guildId: string | null;
  errors: readonly string[];
}

// Pure, non-throwing validation of a single guild config file's raw text.
// Shared by the CLI validator (batch mode over a directory, or a single
// draft file) and anything else that wants a dry-run check without going
// through LocalGuildConfigurationProvider's all-or-nothing directory load.
export function validateGuildConfigurationText(text: string): GuildConfigurationValidationResult {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    return {
      valid: false,
      guildId: null,
      errors: [`Unable to parse YAML: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const result = guildConfigurationFileSchema.safeParse(document);
  if (!result.success) {
    return {
      valid: false,
      guildId: null,
      errors: result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }

  return { valid: true, guildId: result.data.guild.id, errors: [] };
}
