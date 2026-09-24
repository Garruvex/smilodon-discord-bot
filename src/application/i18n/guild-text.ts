import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import { defaultLanguage } from "./language.js";
import { texts, type Texts } from "./texts.js";

// The text for a server's configured language, for code that runs outside a
// command (button presses, schedulers, announcements) and so has no
// context.text. Read fresh each time, so a language change applies to the
// next message. No server, or one without a profile, gets English.
export function textForGuild(
  configurations: Pick<GuildConfigurationProvider, "find">,
  guildId: string | null | undefined,
): Texts {
  const language = guildId ? configurations.find(guildId)?.language : undefined;
  return texts[language ?? defaultLanguage];
}
