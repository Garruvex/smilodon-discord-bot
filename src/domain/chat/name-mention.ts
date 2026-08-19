// Word-boundary, case-insensitive check for whether a message names the bot
// by its configured display name without necessarily @mentioning it — used
// to gate the ambient (non-@mention) chat trigger. \b doesn't work reliably
// around non-ASCII display names, so boundaries are asserted with lookarounds
// against "word" characters instead of relying on \b directly.
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function containsBotName(content: string, displayName: string): boolean {
  const trimmed = displayName.trim();
  if (!trimmed) return false;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}_])`, "iu");
  return pattern.test(content);
}
