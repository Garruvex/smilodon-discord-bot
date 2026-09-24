import type { SettingsTextCatalog } from "../catalog.js";
import { jaAccess } from "./access.js";
import { jaChat } from "./chat.js";
import { jaMemory } from "./memory.js";
import { jaCommunity } from "./community.js";
import { jaMusic } from "./music.js";

// Every registered setting's text, one spread per settings group.
export const jaSettingsText: SettingsTextCatalog = {
  ...jaAccess,
  ...jaMusic,
  ...jaChat,
  ...jaMemory,
  ...jaCommunity,
};
