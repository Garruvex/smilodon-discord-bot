// YouTube credits many uploads to a channel rather than the artist
// ("Artist - Topic", "ArtistVEVO"); searching for, matching on or showing
// that raw name mostly gets it wrong.
export function cleanArtistName(author: string): string {
  return author
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/\s+Official$/i, "")
    .trim();
}
