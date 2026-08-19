// Word-boundary, case-insensitive check for whether a message names the bot
// by its configured display name without necessarily @mentioning it — used
// to gate the ambient (non-@mention) chat trigger. \b doesn't work reliably
// around non-ASCII display names, so boundaries are asserted with lookarounds
// against "word" characters instead of relying on \b directly.
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// CJK ideographs/syllabaries (Han, Hiragana, Katakana, Hangul) aren't
// space-delimited the way Latin scripts are, so a display name like "松果"
// is almost always flanked directly by other CJK characters in a natural
// sentence (e.g. "最近松果都沒來"). Enforcing a word-boundary lookaround on
// that side would reject nearly every real mention, so it's only applied
// when the name's edge character is itself a "word" character in the
// Latin/boundary sense.
const cjkPattern = /[㐀-鿿豈-﫿぀-ヿㇰ-ㇿ가-힯]/u;

export function containsBotName(content: string, displayName: string): boolean {
  const trimmed = displayName.trim();
  if (!trimmed) return false;
  const leadingBoundary = cjkPattern.test(trimmed[0]!) ? "" : "(?<![\\p{L}\\p{N}_])";
  const trailingBoundary = cjkPattern.test(trimmed[trimmed.length - 1]!) ? "" : "(?![\\p{L}\\p{N}_])";
  const pattern = new RegExp(`${leadingBoundary}${escapeRegExp(trimmed)}${trailingBoundary}`, "iu");
  return pattern.test(content);
}
