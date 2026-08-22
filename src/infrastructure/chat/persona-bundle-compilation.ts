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
  // Set by a trailing `{core}` marker on the `##` heading line — an
  // explicit admin override that skips classification for this section
  // entirely, the escape hatch for a section that keeps getting classified
  // as lore even though it should always be sent. Never offered to the
  // model as a choice (see buildPersonaBundleCompilationPrompt) and always
  // excluded from the lore set (see parsePersonaBundleSectionSelection),
  // so it can't be overridden by a classification result either.
  forcedCore: boolean;
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

const forcedCoreMarker = /^(.*?)\s*\{core\}$/i;

function parsePersonalitySections(content: string): ParsedPersonalitySections {
  const matches = [...content.matchAll(/^##[ \t]+(.+?)\r?$/gm)];
  if (matches.length === 0) return { preamble: content.trim(), sections: [] };

  const sections = matches.map((match, index) => {
    const start = match.index;
    const end = matches[index + 1]?.index ?? content.length;
    const markdown = content.slice(start, end).trim();
    const rawHeading = match[1]!.trim();
    const firstLineEnd = markdown.search(/\r?\n/);
    const body = firstLineEnd === -1 ? "" : markdown.slice(firstLineEnd).trim();
    const forcedCoreMatch = rawHeading.match(forcedCoreMarker);
    const forcedCore = forcedCoreMatch !== null;
    const heading = forcedCoreMatch ? forcedCoreMatch[1]!.trim() : rawHeading;
    // Strip the marker from the persisted text — it's upload-authoring
    // syntax, never meant to reach the model as part of the character.
    return {
      index,
      heading,
      markdown: forcedCore ? (body ? `## ${heading}\n${body}` : `## ${heading}`) : markdown,
      body,
      forcedCore,
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
  // Sections pinned with a trailing `{core}` on their heading are already
  // decided — they're left out of the prompt entirely rather than offered
  // as a choice, both to save tokens and so the model can't override an
  // explicit admin decision.
  const classifiableSections = parsePersonalitySections(content).sections.filter((section) => !section.forcedCore);
  const numberedSections = classifiableSections.map((section) =>
    `SECTION INDEX ${section.index}\nHEADING: ${section.heading}\n${wrapUntrusted(section.body)}`,
  ).join("\n\n");
  return `${personaBundleCompilationInstructions}\n\n${numberedSections || "There are no numbered sections; return an empty array."}`;
}

// Validates one classification sample against the section list and returns
// the section indexes it selected as lore — never including a forced-core
// or empty-body section, even if a hallucinating model names one. This is
// a single sample; PersonaBundleCompiler runs several and merges them by
// majority vote before calling assemblePersonaBundle with the result (see
// persona-bundle-compiler.ts). Kept separate from assembly so voting can
// operate on plain index sets instead of reconstructed Markdown.
export function parsePersonaBundleSectionSelection(text: string, content: string): ReadonlySet<number> {
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

  const { sections } = parsePersonalitySections(content);
  const requestedIndexes = result.data.chunkSectionIndexes;
  const selectedIndexes = new Set(requestedIndexes);
  if (selectedIndexes.size !== requestedIndexes.length || requestedIndexes.some((index) => index >= sections.length)) {
    throw new ChatProviderError(
      "The model returned invalid personality section indexes.",
      502,
      "invalid_structured_output",
    );
  }

  return new Set(
    sections
      .filter((section) => selectedIndexes.has(section.index) && section.body.length > 0 && !section.forcedCore)
      .map((section) => section.index),
  );
}

// Builds the final { core, chunks } split from an already-decided lore set
// (typically the majority-vote merge of several parsePersonaBundleSectionSelection
// calls — see PersonaBundleCompiler.compile). Pure reconstruction: never
// rewrites section text, only decides which side of the split each section
// lands on.
export function assemblePersonaBundle(
  content: string,
  loreIndexes: ReadonlySet<number>,
): { core: string; chunks: readonly { heading: string; text: string }[] } {
  const { preamble, sections } = parsePersonalitySections(content);

  // Keep at least one Markdown section in core when there is no preamble,
  // so a classification mistake can never erase the always-sent
  // personality entirely.
  const validChunkIndexes = new Set(
    sections.filter((section) => loreIndexes.has(section.index) && !section.forcedCore).map((section) => section.index),
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

/** Single-sample convenience wrapper (parse + assemble in one call) — kept for callers that don't need self-consistency voting. */
export function parsePersonaBundleCompilationOutput(
  text: string,
  content: string,
): { core: string; chunks: readonly { heading: string; text: string }[] } {
  return assemblePersonaBundle(content, parsePersonaBundleSectionSelection(text, content));
}
