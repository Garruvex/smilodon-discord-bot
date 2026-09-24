import type { SettingsTextCatalog } from "../catalog.js";
import { zhTWAccess } from "./access.js";
import { zhTWChat } from "./chat.js";
import { zhTWMemory } from "./memory.js";
import { zhTWCommunity } from "./community.js";
import { zhTWMusic } from "./music.js";

// Every registered setting's text, one spread per settings group.
export const zhTWSettingsText: SettingsTextCatalog = {
  ...zhTWAccess,
  ...zhTWMusic,
  ...zhTWChat,
  ...zhTWMemory,
  ...zhTWCommunity,
};
