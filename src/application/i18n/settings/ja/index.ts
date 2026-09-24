import type { SettingsTextCatalog } from "../catalog.js";
import { jaAccess } from "./access.js";
import { jaCommunity } from "./community.js";
import { jaMusic } from "./music.js";

// Every registered setting's text, one spread per settings group.
export const jaSettingsText: SettingsTextCatalog = {
  ...jaAccess,
  ...jaMusic,
  ...jaCommunity,
};
