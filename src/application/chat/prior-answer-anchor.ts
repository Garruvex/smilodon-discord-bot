// off: no anchor. shadow: find the match and report it without adding anything. on: add it.
export const priorAnswerAnchorModes = ["off", "shadow", "on"] as const;
export type PriorAnswerAnchorMode = typeof priorAnswerAnchorModes[number];
const continuityStopWords = new Set(["the", "and", "you", "for", "that", "this", "with", "what", "about", "was", "are", "but", "not", "have", "just",
  "they", "your", "can", "how", "its", "yes", "yeah", "lol", "one", "there", "then", "than", "from", "will", "would", "could", "should", "any",
  "anyone", "some", "all", "who", "why", "when", "where", "which", "also", "too", "very", "really", "like", "get", "got", "did", "does", "out"]);
// Lowercased Latin words of three or more letters (minus common words, longer ones cut to a five-letter
// stem so "thinking" meets "think") and CJK character bigrams.
export function continuityTerms(text: string): Set<string> {
  const lower = text.toLowerCase(); const terms = new Set<string>();
  for (const word of lower.match(/[\p{Script=Latin}\p{N}]{3,}/gu) ?? []) if (!continuityStopWords.has(word)) terms.add(word.slice(0, 5));
  for (const run of lower.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? []) {
    for (let index = 0; index + 2 <= run.length; index++) terms.add(run.slice(index, index + 2));
  }
  return terms;
}
// A five-letter Latin stem weighs two; a shorter word or a bigram one. Naming the person who asked
// ("the one you told mira") weighs two. Two is a match.
export const continuityThreshold = 2;
export function continuityScore(query: ReadonlySet<string>, text: ReadonlySet<string>, message = "", asker: string | null = null): number {
  let score = 0; for (const term of query) if (text.has(term)) score += /^[\p{Script=Latin}\p{N}]{5}$/u.test(term) ? 2 : 1;
  const name = asker?.trim().toLowerCase();
  if (name && name.length >= 2 && message.toLowerCase().includes(name)) score += 2;
  return score;
}
export const followUpShaped = (text: string): boolean => text.length <= 120 &&
  /\b(?:it|that|those|these|this|which|other|another|second|first|third|last|instead|same|them)\b|那個|這個|那些|這些|第一|第二|第三|哪個|另一|另外|還有|它|那家|這家|那間|這間/iu.test(text);
