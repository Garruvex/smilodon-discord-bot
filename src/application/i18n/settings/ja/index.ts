import type { SettingsTextCatalog } from "../catalog.js";
import { characterSettingsText } from "../character.js";
import { jaAccess } from "./access.js";
import { jaChat } from "./chat.js";
import { jaMemory } from "./memory.js";
import { jaCommunity } from "./community.js";
import { jaDnd } from "./dnd.js";
import { jaMusic } from "./music.js";
import { jaSecurity } from "./security.js";

// Every registered setting's text, one spread per settings group.
export const jaSettingsText: SettingsTextCatalog = {
  ...characterSettingsText("ja"),
  ...jaAccess,
  ...jaMusic,
  ...jaChat,
  ...jaMemory,
  ...jaDnd,
  ...jaCommunity,
  ...jaSecurity,
};
