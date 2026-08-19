import { ChannelType } from "discord.js";

import type { MutationSettingDefinition } from "./setting-definition.js";
import { formatChannelList, setsDiffer } from "./settings-support.js";

export const linkFixSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "link-fix",
  description: "Configures automatic link previews (Twitter/X, Threads, Instagram, Bilibili, TikTok, Reddit).",
  configureOptions: (b) => b
    .addBooleanOption((o) => o.setName("enabled").setDescription("Turn automatic link rewriting on or off."))
    .addChannelOption((o) => o.setName("channel").setDescription("Adds a text channel to watch for rewritable links.").addChannelTypes(ChannelType.GuildText))
    .addChannelOption((o) => o.setName("remove-channel").setDescription("Removes a text channel from the watched list.").addChannelTypes(ChannelType.GuildText)),
  handle: (context, _deps, previousProfile, input) => {
    const enabled = context.interaction.options.getBoolean("enabled");
    const channel = context.interaction.options.getChannel("channel");
    const removeChannel = context.interaction.options.getChannel("remove-channel");
    const channelIds = new Set(previousProfile.channels.linkFix);
    if (channel) channelIds.add(channel.id);
    if (removeChannel) channelIds.delete(removeChannel.id);
    if (channel || removeChannel) input.linkFixChannelIds = [...channelIds];
    if (enabled !== null) input.linkFixEnabled = enabled;
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
  fieldChanges: [{ label: "Link fix enabled", read: (p) => p.features.linkFix }],
  extraLines: (previous, updated) =>
    setsDiffer(previous.channels.linkFix, updated.channels.linkFix)
      ? [`Link fix watched channels: ${formatChannelList(updated.channels.linkFix)}`]
      : [],
};
