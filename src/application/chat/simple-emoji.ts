// Reactions the simple contract may choose: a small fixed Unicode set plus a bounded
// random sample of the guild's own custom emoji. The cap keeps the decision cheap; the
// sample is seeded by the message so one decision is reproducible.
export const simpleEmoji = ["👍", "❤️", "😂", "😮", "😢", "🎉", "🤔", "👀"] as const;
export const serverEmojiCap = 20;

export interface ServerEmoji { id: string; name: string; animated: boolean }
export type SimpleEmojiOption = { token: string; kind: "unicode" } | { token: string; kind: "custom"; id: string; name: string; animated: boolean };
export const unicodeEmojiChoices: readonly SimpleEmojiOption[] = simpleEmoji.map((token) => ({ token, kind: "unicode" as const }));

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const character of seed) state = Math.imul(state ^ character.codePointAt(0)!, 16777619);
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// The model sees `:name:` and never an ID; the app maps the answer back through this list.
export function buildEmojiChoices(custom: readonly ServerEmoji[], seed: string, cap = serverEmojiCap): readonly SimpleEmojiOption[] {
  const names = new Set<string>();
  const pool = custom.filter((emoji) => {
    if (!/^\w{2,32}$/u.test(emoji.name) || names.has(emoji.name)) return false;
    names.add(emoji.name); return true;
  });
  const random = seededRandom(seed);
  for (let index = pool.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [pool[index], pool[other]] = [pool[other]!, pool[index]!];
  }
  return [...unicodeEmojiChoices, ...pool.slice(0, Math.max(0, cap)).map((emoji) => ({ token: `:${emoji.name}:`, kind: "custom" as const, id: emoji.id, name: emoji.name, animated: emoji.animated }))];
}
