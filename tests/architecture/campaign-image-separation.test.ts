import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// The campaign's pictures are their own path: its own prompts, its own image
// connection (CAMPAIGN_IMAGE_*), and nothing from the chat personality or the
// chat's image tools. These files may not reach into the chat, and the chat may
// not reach into them.

const root = path.resolve(__dirname, "../../src");

function sources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(full) : full.endsWith(".ts") ? [full] : [];
  });
}

const importsOf = (file: string): string[] => [...fs.readFileSync(file, "utf8").matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");

const imagePath = [
  ...sources(path.join(root, "application/campaign")),
  ...sources(path.join(root, "infrastructure/campaign/image")),
];
const chatPath = [...sources(path.join(root, "application/chat")), ...sources(path.join(root, "infrastructure/chat"))];

describe("the campaign's image path", () => {
  it("imports nothing from the chat", () => {
    const offenders = imagePath.filter((file) => importsOf(file).some((target) => /(^|\/)(application|infrastructure)\/chat(\/|$)|\/chat\//.test(target)));
    expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
  });

  it("reads no chat setting, persona or chat image option", () => {
    const offenders = [...imagePath, ...sources(path.join(root, "infrastructure/campaign"))].filter((file) => /CHATBOT_|GenerateSelfImage|imageGenerationEnabled|ReferenceImageGenerator/.test(fs.readFileSync(file, "utf8")));
    expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
  });

  it("is not imported by the chat", () => {
    const offenders = chatPath.filter((file) => importsOf(file).some((target) => /\/campaign\//.test(target)));
    expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
  });

  it("builds every prompt in one place", () => {
    // No other file in the campaign writes a picture prompt of its own.
    const others = imagePath.filter((file) => !file.endsWith(`images${path.sep}image-prompts.ts`));
    const offenders = others.filter((file) => /fantasy (illustration|character portrait)|brushwork|watermark/i.test(fs.readFileSync(file, "utf8")));
    expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
  });
});
