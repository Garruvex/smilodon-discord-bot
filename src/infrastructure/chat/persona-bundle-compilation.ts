import { z } from "zod";

import { ChatProviderError } from "../../application/chat/chat-provider.js";

const personaBundleClassificationSchema = z.object({
  chunkSectionIndexes: z.array(z.number().int().nonnegative()).max(64),
});

export const personaBundleCompilationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["chunkSectionIndexes"],
  properties: {
    chunkSectionIndexes: {
      type: "array",
      maxItems: 64,
      items: { type: "integer", minimum: 0 },
    },
  },
} as const;

// Classification emits only section indexes, not a copy of the uploaded
// Markdown. This is ample room even at the 64-chunk bundle limit.
export const personaBundleCompilationMaxOutputTokens = 4_000;

// The input can still be a 64 KB upload, so retain a long request allowance
// even though the output is now deliberately small.
export const personaBundleCompilationTimeoutMs = 180_000;

interface PersonalitySection {
  index: number;
  heading: string;
  markdown: string;
  body: string;
}

interface ParsedPersonalitySections {
  preamble: string;
  sections: readonly PersonalitySection[];
}

const untrustedOpenTag = "<<<BEGIN-UNTRUSTED-DATA>>>";
const untrustedCloseTag = "<<<END-UNTRUSTED-DATA>>>";

function wrapUntrusted(text: string): string {
  const sanitized = text.replaceAll(untrustedOpenTag, "[tag]").replaceAll(untrustedCloseTag, "[tag]");
  return `${untrustedOpenTag}\n${sanitized}\n${untrustedCloseTag}`;
}

function parsePersonalitySections(content: string): ParsedPersonalitySections {
  const matches = [...content.matchAll(/^##[ \t]+(.+?)\r?$/gm)];
  if (matches.length === 0) return { preamble: content.trim(), sections: [] };

  const sections = matches.map((match, index) => {
    const start = match.index;
    const end = matches[index + 1]?.index ?? content.length;
    const markdown = content.slice(start, end).trim();
    const firstLineEnd = markdown.search(/\r?\n/);
    return {
      index,
      heading: match[1]!.trim(),
      markdown,
      body: firstLineEnd === -1 ? "" : markdown.slice(firstLineEnd).trim(),
    };
  });
  return { preamble: content.slice(0, matches[0]!.index).trim(), sections };
}

const personaBundleCompilationInstructions =
  `Classify the numbered sections from a guild's chatbot personality file. Return only the indexes of sections that ` +
  `are situational lore, backstory, relationships, or specific knowledge relevant only when conversation touches that ` +
  `topic. Do not include identity, voice, tone, general behavior rules, or anything that applies to every message. ` +
  `When uncertain, leave the section out so it remains core. Do not copy or rewrite any section text.`;

export function buildPersonaBundleCompilationPrompt(content: string): string {
  const { sections } = parsePersonalitySections(content);
  const numberedSections = sections.map((section) =>
    `SECTION INDEX ${section.index}\nHEADING: ${section.heading}\n${wrapUntrusted(section.body)}`,
  ).join("\n\n");
  return `${personaBundleCompilationInstructions}\n\n${numberedSections || "There are no numbered sections; return an empty array."}`;
}

export function parsePersonaBundleCompilationOutput(
  text: string,
  content: string,
): { core: string; chunks: readonly { heading: string; text: string }[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ChatProviderError("The model returned a reply that was not valid JSON.", 502, "invalid_structured_output");
  }
  const result = personaBundleClassificationSchema.safeParse(parsed);
  if (!result.success) {
    throw new ChatProviderError(
      "The model returned a reply that did not match the expected schema.",
      502,
      "invalid_structured_output",
    );
  }

  const { preamble, sections } = parsePersonalitySections(content);
  const requestedIndexes = result.data.chunkSectionIndexes;
  const selectedIndexes = new Set(requestedIndexes);
  if (selectedIndexes.size !== requestedIndexes.length || requestedIndexes.some((index) => index >= sections.length)) {
    throw new ChatProviderError(
      "The model returned invalid personality section indexes.",
      502,
      "invalid_structured_output",
    );
  }

  // Empty sections cannot be useful lore chunks. Also keep at least one
  // Markdown section in core when there is no preamble, so a classification
  // mistake can never erase the always-sent personality entirely.
  const validChunkIndexes = new Set(
    sections
      .filter((section) => selectedIndexes.has(section.index) && section.body.length > 0)
      .map((section) => section.index),
  );
  if (!preamble && validChunkIndexes.size === sections.length && sections.length > 0) {
    validChunkIndexes.delete(sections[0]!.index);
  }

  const core = [
    preamble,
    ...sections.filter((section) => !validChunkIndexes.has(section.index)).map((section) => section.markdown),
  ].filter(Boolean).join("\n\n");
  const chunks = sections
    .filter((section) => validChunkIndexes.has(section.index))
    .map((section) => ({ heading: section.heading, text: section.body }));
  return { core, chunks };
}
