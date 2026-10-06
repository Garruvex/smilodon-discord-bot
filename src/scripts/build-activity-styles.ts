import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// The Activity's styles are layered redesigns, so the order of the files in styles/index.css is the order of the cascade. They are joined
// as they are, with nothing rewritten, so the page gets exactly the text that was written.
const directory = resolve(process.cwd(), "src", "activity", "styles");
const index = readFileSync(resolve(directory, "index.css"), "utf8");
const files = [...index.matchAll(/^@import "\.\/([^"]+)";$/gm)].map((match) => match[1] as string);
if (files.length === 0) throw new Error("styles/index.css imports no files");

const parts = files.map((file) => `/* ${file} */\n${readFileSync(resolve(directory, file), "utf8").trimEnd()}\n`);
writeFileSync(resolve(process.cwd(), "assets", "activity", "styles.css"), `/* Built by npm run build:activity from src/activity/styles. Edit those files, not this one. */\n${parts.join("\n")}`, "utf8");
