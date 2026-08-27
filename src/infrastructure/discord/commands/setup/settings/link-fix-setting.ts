import type { GuildConfiguration, LinkFixPlatform } from "../../../../../config/guild-configuration.js";
import type { MutationSettingDefinition } from "./setting-definition.js";
import { formatChannelList, setsDiffer } from "./settings-support.js";

// Option name -> platform key, and the human label used in confirmation
// diffs. Order here also drives configureOptions() and fieldChanges below.
const platformOptions: readonly { name: string; key: LinkFixPlatform; label: string }[] = [
  { name: "twitter", key: "twitter", label: "Twitter/X" },
  { name: "threads", key: "threads", label: "Threads" },
  { name: "tiktok", key: "tiktok", label: "TikTok" },
  { name: "instagram", key: "instagram", label: "Instagram" },
  { name: "reddit", key: "reddit", label: "Reddit" },
  { name: "bilibili", key: "bilibili", label: "Bilibili" },
];

export const linkFixSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "link-fix",
  description: "Configures automatic link previews (Twitter/X, Threads, Instagram, Bilibili, TikTok, Reddit).",
  configureOptions: () => [
    { type: "boolean", name: "enabled", description: "Turn automatic link rewriting on or off." },
    { type: "channel", name: "channel", description: "Adds a text channel to watch for rewritable links.", guildTextOnly: true },
    { type: "channel", name: "remove-channel", description: "Removes a text channel from the watched list.", guildTextOnly: true },
    ...platformOptions.map((platform) => ({
      type: "boolean" as const,
      name: platform.name,
      description: `Turn ${platform.label} link fixing on or off.`,
    })),
  ],
  handle: (context, _deps, previousProfile, input) => {
    const enabled = context.interaction.options.getBoolean("enabled");
    const channel = context.interaction.options.getChannel("channel");
    const removeChannel = context.interaction.options.getChannel("remove-channel");
    const channelIds = new Set(previousProfile.channels.linkFix);
    if (channel) channelIds.add(channel.id);
    if (removeChannel) channelIds.delete(removeChannel.id);
    if (channel || removeChannel) input.linkFixChannelIds = [...channelIds];
    if (enabled !== null) input.linkFixEnabled = enabled;

    const platformOverrides: Partial<Record<LinkFixPlatform, boolean>> = {};
    for (const platform of platformOptions) {
      const value = context.interaction.options.getBoolean(platform.name);
      if (value !== null) platformOverrides[platform.key] = value;
    }
    if (Object.keys(platformOverrides).length > 0) input.linkFixPlatformOverrides = platformOverrides;

    const nextEnabled = enabled ?? previousProfile.features.linkFix;
    const nextChannelCount = input.linkFixChannelIds?.length ?? previousProfile.channels.linkFix.size;
    if (nextEnabled && nextChannelCount === 0) {
      return Promise.resolve({
        ok: false,
        message: "Add at least one watched channel with `channel:<channel>` before enabling this feature.",
      });
    }
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [
    { label: "Link fix enabled", read: (p) => p.features.linkFix },
    ...platformOptions.map((platform) => ({
      label: `${platform.label} link fix`,
      read: (p: GuildConfiguration) => p.linkFixPlatforms[platform.key],
    })),
  ],
  extraLines: (previous, updated) =>
    setsDiffer(previous.channels.linkFix, updated.channels.linkFix)
      ? [`Link fix watched channels: ${formatChannelList(updated.channels.linkFix)}`]
      : [],
};
