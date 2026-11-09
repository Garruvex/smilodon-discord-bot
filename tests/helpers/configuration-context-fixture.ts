import { GuardedConfigurationContext, type ConfigurationKind } from "../../src/application/context/guarded-configuration-context.js";

// Explicit synthetic configuration authority. Never used for live sources.
export function configurationFixture(text: string, kind: ConfigurationKind = "persona_upload", current: () => boolean = () => true, guildId = "synthetic-guild"): Promise<GuardedConfigurationContext> {
  return GuardedConfigurationContext.open({ kind, guildId, ownerUserId: kind === "user_preferences" ? "synthetic-user" : null }, { text }, current);
}
