export interface ExampleExchange {
  tags: string;
  user: string;
  character: string;
  // Present only when loaded from a compiled examples.bundle.json sidecar
  // (see example-exchange-bundle.ts) — null/undefined for exchanges parsed
  // straight from examples.md, which RelevantExampleExchangeSelector treats
  // as a 0 similarity contribution, same convention as ChatMemoryRecord.embedding.
  embedding?: readonly number[] | null;
}

export const exampleExchangeLimits = {
  maxExamples: 200,
  maxSerializedChars: 16_000,
} as const;

const headingPattern = /^### /m;
// [ \t]* (not \s*) after the label — \s matches \n, which would otherwise
// swallow the line break itself and pull the next line's content up into
// this capture group.
const tagsLinePattern = /^Tags:[ \t]*(.*)$/m;
// Captures everything after "User:" up to (but not including) the next
// "Character:" line — the non-greedy [\s\S]*? plus a lookahead lets a reply
// span multiple lines without swallowing the Character block.
const userLinePattern = /^User:[ \t]*([\s\S]*?)(?=\nCharacter:|$)/m;
const characterLinePattern = /^Character:[ \t]*([\s\S]*)$/m;

/**
 * Parses a guild-uploaded `examples.md` into discrete {user, character}
 * exchanges. Fails the whole file on the first malformed block — no silent
 * partial acceptance, since a half-parsed example set would degrade voice
 * quality in a way nobody would notice until the bot started sounding off.
 */
export function parseExampleExchanges(
  content: string,
): { exchanges: ExampleExchange[] } | { error: string } {
  if (!headingPattern.test(content)) {
    return { error: "No \"### Example\" blocks found." };
  }
  const blocks = content.split(headingPattern).map((block) => block.trim()).filter((block) => block.length > 0);
  if (blocks.length > exampleExchangeLimits.maxExamples) {
    return { error: `Too many examples (${blocks.length}); the limit is ${exampleExchangeLimits.maxExamples}.` };
  }

  const exchanges: ExampleExchange[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;
    const label = `Example #${index + 1}`;
    const userMatch = userLinePattern.exec(block);
    if (!userMatch) return { error: `${label}: missing a "User:" line.` };
    const characterMatch = characterLinePattern.exec(block);
    if (!characterMatch) return { error: `${label}: missing a "Character:" line.` };
    const user = userMatch[1]!.trim();
    const character = characterMatch[1]!.trim();
    if (!user) return { error: `${label}: "User:" text is empty.` };
    if (!character) return { error: `${label}: "Character:" text is empty.` };
    const tagsMatch = tagsLinePattern.exec(block);
    exchanges.push({ tags: tagsMatch?.[1]?.trim() ?? "", user, character });
  }
  return { exchanges };
}
