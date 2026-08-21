import { AttachmentBuilder, type InteractionEditReplyOptions } from "discord.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ReadOnlySettingDefinition } from "./setting-definition.js";

// Repo-committed starter content (not guild data) — the same files
// documented in docs/personality-guide.md and kept parser-verified there.
// Read from disk per request rather than embedded as a string constant so
// there's exactly one copy of each template to keep in sync.
const templates = {
  personality: {
    path: "config/examples/personality.example.md",
    filename: "personality.md",
    uploadOption: "personality",
  },
  examples: {
    path: "config/examples/examples.example.md",
    filename: "examples.md",
    uploadOption: "examples",
  },
} as const;

type TemplateKind = keyof typeof templates;

export const templateSetting: ReadOnlySettingDefinition = {
  kind: "readOnly",
  name: "template",
  description: "Sends a starter personality.md or examples.md to edit and upload.",
  configureOptions: () => [
    {
      type: "string", name: "kind", description: "Which starter file to send.", required: true,
      choices: [
        { name: "Personality", value: "personality" satisfies TemplateKind },
        { name: "Examples", value: "examples" satisfies TemplateKind },
      ],
    },
  ],
  run: (context): Promise<InteractionEditReplyOptions> => {
    const kind = context.interaction.options.getString("kind", true) as TemplateKind;
    const template = templates[kind];
    const content = readFileSync(resolve(template.path), "utf8");
    return Promise.resolve({
      content: `Starter \`${template.filename}\` — edit it, then upload with ` +
        `\`/settings chat chatbot ${template.uploadOption}:<file>\`.`,
      files: [new AttachmentBuilder(Buffer.from(content, "utf8"), { name: template.filename })],
    });
  },
};
