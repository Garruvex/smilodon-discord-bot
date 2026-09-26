// Channel names come from the campaign name. Discord text channel names are
// lowercase with no spaces and at most 100 characters; letters from any script
// are allowed, so "月光遺跡" stays readable. Each game gets two channels:
// "<name>" for the adventure and "<name>-stats" for the party dashboard.

const maxLength = 100;
const suffix = "-stats";

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 ? "campaign" : [...slug].slice(0, maxLength - suffix.length - 4).join("").replace(/-+$/g, "") || "campaign";
}

export interface GameChannelNames {
  readonly adventure: string;
  readonly party: string;
}

// The pair of names for a new game, with a short numeric suffix on both when
// either is already taken in the category.
export function gameChannelNames(campaignName: string, taken: ReadonlySet<string>): GameChannelNames {
  const base = slugify(campaignName);
  for (let attempt = 1; ; attempt += 1) {
    const stem = attempt === 1 ? base : `${base}-${attempt}`;
    const names = { adventure: stem, party: `${stem}${suffix}` };
    if (!taken.has(names.adventure) && !taken.has(names.party)) return names;
  }
}

// A marker kept in a channel's topic so a leftover from an uncertain create
// can be found again instead of duplicated.
export function resourceMarker(campaignId: string, kind: string): string {
  return `dnd:${campaignId}:${kind}`;
}
