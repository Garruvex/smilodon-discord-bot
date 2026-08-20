// Word-boundary, case-insensitive check for whether a message names the bot
// by its configured display name without necessarily @mentioning it — used
// to gate the ambient (non-@mention) chat trigger. \b doesn't work reliably
// around non-ASCII display names, so boundaries are asserted manually
// instead of relying on \b directly.
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Several scripts (Han, Hiragana, Katakana, Hangul, Thai, Lao, Khmer,
// Myanmar, ...) aren't space-delimited the way Latin scripts are, so any
// name — in one of those scripts or in Latin — is routinely flanked
// directly by characters from one of those scripts in a natural sentence
// (e.g. "最近松果都沒來", "yohta我想聽好睡的歌", "สวัสดีโยธาครับ"). A boundary
// check based on generic \p{L} would wrongly treat that adjacency as
// "inside a word" since those scripts' characters are letters too, so
// neighbors from any of these scripts are always treated as a valid
// boundary — only a word character from a space-delimited script blocks the
// match (e.g. the "b" in "yohtabot").
const noSpaceScriptPattern =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const latinWordCharPattern = /[\p{L}\p{N}_]/u;

function isBoundary(char: string | undefined): boolean {
  if (char === undefined) return true;
  if (noSpaceScriptPattern.test(char)) return true;
  return !latinWordCharPattern.test(char);
}

export function containsBotName(content: string, displayName: string): boolean {
  const trimmed = displayName.trim();
  if (!trimmed) return false;
  const pattern = new RegExp(escapeRegExp(trimmed), "giu");
  for (const match of content.matchAll(pattern)) {
    const before = content[match.index - 1];
    const after = content[match.index + match[0].length];
    if (isBoundary(before) && isBoundary(after)) return true;
  }
  return false;
}
