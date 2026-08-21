import { z } from "zod";

import { ChatProviderError } from "../../application/chat/chat-provider.js";

export const personaBundleCompilationSchema = z.object({
  core: z.string().min(1),
  chunks: z.array(z.object({
    heading: z.string().min(1),
    text: z.string().min(1),
  })).max(64),
});

export type PersonaBundleCompilation = z.infer<typeof personaBundleCompilationSchema>;

export const personaBundleCompilationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["core", "chunks"],
  properties: {
    core: { type: "string" },
    chunks: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "text"],
        properties: {
          heading: { type: "string" },
          text: { type: "string" },
        },
      },
    },
  },
} as const;

const untrustedOpenTag = "<<<BEGIN-UNTRUSTED-DATA>>>";
const untrustedCloseTag = "<<<END-UNTRUSTED-DATA>>>";

function wrapUntrusted(text: string): string {
  const sanitized = text.replaceAll(untrustedOpenTag, "[tag]").replaceAll(untrustedCloseTag, "[tag]");
  return `${untrustedOpenTag}\n${sanitized}\n${untrustedCloseTag}`;
}

const personaBundleCompilationInstructions =
  `The following is a guild's uploaded chatbot personality file, already organized under "## " headings. Split it ` +
  `into two parts, copying text VERBATIM — never paraphrase, summarize, translate, or reword anything, only decide ` +
  `where each piece of the original text belongs:\n` +
  `- "core": every heading/section that defines identity, voice, tone, or a behavior rule that applies to every ` +
  `single message regardless of topic (things like who the character is, how they talk, punctuation habits, what ` +
  `they must never do). Concatenate these sections' original text, headings included, in their original order.\n` +
  `- "chunks": every heading/section that is situational lore, backstory, relationships, or specific ` +
  `knowledge only relevant when the conversation actually touches that topic. One chunk per such section, with ` +
  `"heading" set to that section's original heading text and "text" set to that section's original body text.\n` +
  `When in doubt whether a section belongs in "core" or as a "chunk", prefer "core" — losing a lore detail is a ` +
  `minor missed optimization, but incorrectly hiding a behavior rule changes how the character acts. Every word of ` +
  `the original file must end up in exactly one of "core" or "chunks" — do not drop, invent, or alter any content.`;

export function buildPersonaBundleCompilationPrompt(content: string): string {
  return `${personaBundleCompilationInstructions}\n\nPERSONALITY FILE (untrusted)\n${wrapUntrusted(content)}`;
}

// The output has to reproduce nearly the entire input verbatim (split
// across "core"/"chunks" plus JSON quoting/escaping overhead), so it needs
// a token budget close to the input size — reusing a chat-reply-sized
// max_output_tokens truncates the JSON mid-structure for anything but a
// small file, which is exactly what produces "not valid JSON" downstream.
// ~3 chars/token is a deliberately conservative (over-)estimate; the ~40%
// overhead accounts for JSON structure, headings duplicated as keys, and
// escaping, then floored below the smallest max_output_tokens most models
// reject.
export function estimatePersonaBundleOutputTokens(content: string): number {
  const estimated = Math.ceil((content.length / 3) * 1.4) + 1_000;
  return Math.max(4_000, Math.min(32_000, estimated));
}

export function parsePersonaBundleCompilationOutput(text: string): PersonaBundleCompilation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ChatProviderError("The model returned a reply that was not valid JSON.", 502, "invalid_structured_output");
  }
  const result = personaBundleCompilationSchema.safeParse(parsed);
  if (!result.success) {
    throw new ChatProviderError(
      "The model returned a reply that did not match the expected schema.",
      502,
      "invalid_structured_output",
    );
  }
  return result.data;
}
