import type { SettingsGroup } from "../registry/types.js";
import { access } from "./access.js";
import { chat } from "./chat.js";
import { community } from "./community.js";
import { memory } from "./memory.js";
import { music } from "./music.js";

// Every registered settings group, in the order the admin panel shows them.
// Each becomes /settings-<name>; see ../registry for how the rest follows.
export const settingsRegistry: readonly SettingsGroup[] = [access, music, chat, memory, community];
