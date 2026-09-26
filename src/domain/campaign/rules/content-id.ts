// Stable identifiers for rules content, e.g. "spell:cure-wounds". An ID is
// never renamed or reused once shipped: saved campaigns, events, glossaries,
// and adventure files all refer to content by ID.

export const contentKinds = ["action", "class", "condition", "feature", "item", "monster", "spell"] as const;
export type ContentKind = (typeof contentKinds)[number];

export type ContentId<K extends ContentKind = ContentKind> = `${K}:${string}`;

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ParsedContentId {
  readonly kind: ContentKind;
  readonly slug: string;
}

export function parseContentId(value: string): ParsedContentId | null {
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  const kind = value.slice(0, separator);
  const slug = value.slice(separator + 1);
  if (!isContentKind(kind) || !slugPattern.test(slug)) return null;
  return { kind, slug };
}

export function isContentId<K extends ContentKind>(value: string, kind: K): value is ContentId<K> {
  return parseContentId(value)?.kind === kind;
}

function isContentKind(value: string): value is ContentKind {
  return (contentKinds as readonly string[]).includes(value);
}
