// A marker kept in a resource's topic (a text channel) or starter message (a
// forum post) so a leftover from an uncertain create can be found again
// instead of duplicated.
export function resourceMarker(campaignId: string, kind: string): string {
  return `dnd:${campaignId}:${kind}`;
}
