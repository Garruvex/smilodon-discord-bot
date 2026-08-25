import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GlobalFonts } from "@napi-rs/canvas";

// Shared by every generated-image command (quote, welcome, ...) so the same
// font isn't registered twice under two independent module-load side
// effects. Alpine (this bot's Docker base image) has no system fonts at
// all, so bundling + explicitly registering one is required, not optional —
// see assets/fonts/NotoSansTC-OFL.txt for the license.
export const fontFamily = "Noto Sans TC";

const fontPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../assets/fonts/NotoSansTC-Variable.ttf",
);
GlobalFonts.registerFromPath(fontPath, fontFamily);
