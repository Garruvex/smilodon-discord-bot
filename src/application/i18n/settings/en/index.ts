import type { SettingsTextCatalog } from "../catalog.js";
import { enAccess } from "./access.js";
import { enCommunity } from "./community.js";
import { enMusic } from "./music.js";

// Every registered setting's text, one spread per settings group.
export const enSettingsText: SettingsTextCatalog = {
  ...enAccess,
  ...enMusic,
  ...enCommunity,
};
