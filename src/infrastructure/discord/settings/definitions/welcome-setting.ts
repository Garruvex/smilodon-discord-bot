import type { MutationSettingDefinition } from "./setting-definition.js";
import { formatChannelMention } from "./settings-support.js";

export const welcomeSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "welcome",
  description: "Sets join/leave announcement channels.",
  configureOptions: () => [
    { type: "channel", name: "join-channel", description: "Where new-member welcome cards are posted.", guildTextOnly: true },
    { type: "channel", name: "leave-channel", description: "Where member-left messages are posted.", guildTextOnly: true },
  ],
  handle: (request, _deps, _previousProfile, input) => {
    const joinChannel = request.values.getChannel("join-channel");
    const leaveChannel = request.values.getChannel("leave-channel");
    if (joinChannel) input.joinAnnouncementsChannelId = joinChannel.id;
    if (leaveChannel) input.leaveAnnouncementsChannelId = leaveChannel.id;
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [
    { label: "Join announcements channel", read: (p) => formatChannelMention(p.channels.joinAnnouncements) },
    { label: "Leave announcements channel", read: (p) => formatChannelMention(p.channels.leaveAnnouncements) },
  ],
};
