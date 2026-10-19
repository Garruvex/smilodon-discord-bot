import type { SettingsTextCatalog } from "../catalog.js";
import { chatPolicySettingsText } from "../chat-policy.js";
import { characterSettingsText } from "../character.js";
import { zhTWAccess } from "./access.js";
import { zhTWChat } from "./chat.js";
import { zhTWMemory } from "./memory.js";
import { zhTWCommunity } from "./community.js";
import { zhTWDnd } from "./dnd.js";
import { zhTWMusic } from "./music.js";
import { zhTWSecurity } from "./security.js";

// Every registered setting's text, one spread per settings group.
export const zhTWSettingsText: SettingsTextCatalog = {
  ...chatPolicySettingsText("zh-TW"),
  ...characterSettingsText("zh-TW"),
  ...zhTWAccess,
  ...zhTWMusic,
  ...zhTWChat,
  ...zhTWMemory,
  ...zhTWDnd,
  ...zhTWCommunity,
  ...zhTWSecurity,
};
