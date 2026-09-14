import { z } from "zod";

export interface SyncedLyricLine {
  readonly timestampMs: number;
  readonly line: string;
}

const lrcLibCandidateSchema = z.object({
  id: z.number().optional(),
  trackName: z.string(),
  artistName: z.string(),
  albumName: z.string().nullable().optional(),
  duration: z.number().nullable().optional(),
  syncedLyrics: z.string().nullable().optional(),
  plainLyrics: z.string().nullable().optional(),
});
const lrcLibSearchResponseSchema = z.array(lrcLibCandidateSchema);
type LrcLibCandidate = z.infer<typeof lrcLibCandidateSchema>;

const lrcLineExpression = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/;

function parseSyncedLyrics(syncedLyrics: string): SyncedLyricLine[] {
  const lines: SyncedLyricLine[] = [];
  for (const rawLine of syncedLyrics.split("\n")) {
    const match = lrcLineExpression.exec(rawLine.trim());
    if (!match) continue;
    const text = match[3]?.trim();
    if (!text) continue;
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    lines.push({ timestampMs: Math.round((minutes * 60 + seconds) * 1000), line: text });
  }
  return lines.sort((a, b) => a.timestampMs - b.timestampMs);
}

// Ported from a sibling project's battle-tested lyrics matcher (a Go
// service that resolves LRCLIB/NetEase lyrics for a wallpaper companion
// app) — ours is the LRCLIB-only subset of that pipeline. See that
// project's internal/lyrics/lyrics.go for the original.

// Strips YouTube/video-style suffixes — "(Official Video)", "[Official
// Music Video]", "(Lyrics)", "(Audio)", "(Visualizer)" — that Lavalink's
// track title carries verbatim when a track was resolved via YouTube search
// rather than Spotify, and which LRCLIB's own titles never include.
const metadataSuffixPattern = /\s*[[(](?:official\s+)?(?:(?:music\s+)?video(?:\s+clip)?|audio|lyrics?|lyric\s+video|visuali[sz]er)[\])]/gi;
const artistTitleSeparatorPattern = /\s+[-–—]\s+/;
const nonWordPattern = /[^\p{L}\p{N}]+/gu;
const versionMarkerPattern = /\b(live|remix|acoustic|instrumental|karaoke|demo|edit|version|cover|sped ?up|slowed)\b/i;
// Splits a multi-artist credit ("Owl City, Carly Rae Jepsen", "A feat. B")
// into individual names — LRCLIB indexes duet/feature tracks under all
// sorts of artist-string spellings, so trying each artist alone
// significantly widens what can match.
const artistSeparatorPattern = /\s*(?:,|&|\/|;|、|，|\bfeat(?:uring)?\.?\b|\bft\.?\b|和|與|与)\s*/gi;

function stripMetadataSuffix(value: string): string {
  return value.replace(metadataSuffixPattern, " ").trim();
}

interface NormalizedQuery {
  readonly title: string;
  readonly artist: string;
  // A YouTube-style title ("Artist - Title (Official Video)") often carries
  // a more reliable artist credit than the channel/author metadata — kept
  // as an extra candidate rather than replacing the original outright, so a
  // bad split can't make matching strictly worse than not normalizing at all.
  readonly extraArtist: string | null;
}

function normalizeQuery(title: string, artist: string): NormalizedQuery {
  const trimmedTitle = title.trim();
  const trimmedArtist = artist.trim();
  const cleanTitle = stripMetadataSuffix(trimmedTitle);
  // Try the "Artist - Title" split unconditionally — not just when a
  // metadata suffix was also present to strip. A source can hand us a
  // perfectly clean "Artist - Title" already (no "(Official Video)" etc. to
  // strip at all, e.g. because the upstream plugin already stripped it), and
  // gating the split on the suffix check meant that case searched LRCLIB for
  // the literal, unsplit "Artist - Title" string and never found anything.
  const separatorMatch = artistTitleSeparatorPattern.exec(cleanTitle);
  if (separatorMatch) {
    const derivedArtist = cleanTitle.slice(0, separatorMatch.index).trim();
    const derivedTitle = cleanTitle.slice(separatorMatch.index + separatorMatch[0].length).trim();
    if (derivedArtist && derivedTitle) {
      return { title: derivedTitle, artist: trimmedArtist, extraArtist: derivedArtist };
    }
  }
  return { title: cleanTitle, artist: trimmedArtist, extraArtist: null };
}

function artistSearchVariants(artist: string): string[] {
  const trimmed = artist.trim();
  const variants = [trimmed];
  const seen = new Set([trimmed.toLowerCase()]);
  for (const part of trimmed.split(artistSeparatorPattern)) {
    const cleaned = part.trim();
    const key = cleaned.toLowerCase();
    if (cleaned && !seen.has(key)) {
      seen.add(key);
      variants.push(cleaned);
    }
  }
  if (!seen.has("")) variants.push("");
  return variants;
}

function normalizedMetadata(value: string): string {
  const lowered = stripMetadataSuffix(value.toLowerCase());
  return lowered.replace(nonWordPattern, " ").trim();
}

interface MatchResult {
  readonly score: number;
  readonly match: boolean;
}

function metadataMatchScore(want: string, got: string): MatchResult {
  const normalizedWant = normalizedMetadata(want);
  const normalizedGot = normalizedMetadata(got);
  if (normalizedWant === "") return { score: 0, match: true };
  if (normalizedGot === "") return { score: 0, match: false };
  if (normalizedWant === normalizedGot) return { score: 1, match: true };
  if (normalizedWant.includes(normalizedGot) || normalizedGot.includes(normalizedWant)) {
    const shorter = Math.min(normalizedWant.length, normalizedGot.length);
    const longer = Math.max(normalizedWant.length, normalizedGot.length);
    return { score: 0.7 + 0.2 * (shorter / longer), match: true };
  }
  return { score: 0, match: false };
}

// A vocalist is often credited as "name from group" in one metadata source
// and just "name" in another (this is exactly what tripped up 猫日's
// "suis from ヨルシカ" — LRCLIB only has "suis from Yorushika"). Kept
// deliberately narrow: the shorter name must be a complete prefix of the
// longer one via an explicit "from" credit, not just any substring.
function artistMatchScore(want: string, got: string): MatchResult {
  let best = 0;
  for (const variant of artistSearchVariants(want)) {
    if (!variant) continue;
    const result = metadataMatchScore(variant, got);
    if (result.match && result.score > best) best = result.score;
  }
  if (best >= 0.8) return { score: best, match: true };

  const direct = metadataMatchScore(want, got);
  if (!direct.match) return { score: 0, match: false };
  if (direct.score >= 0.8) return direct;

  const normalizedWant = normalizedMetadata(want);
  const normalizedGot = normalizedMetadata(got);
  const [shorter, longer] = normalizedWant.length <= normalizedGot.length
    ? [normalizedWant, normalizedGot]
    : [normalizedGot, normalizedWant];
  if (shorter.length >= 3 && longer.startsWith(`${shorter} from `)) {
    return { score: 0.9, match: true };
  }
  return direct;
}

// Some providers prefix the track title with the artist name; strip it so
// title comparison isn't penalized for a prefix that isn't really part of
// the title.
function candidateTitle(candidate: LrcLibCandidate): string {
  const title = normalizedMetadata(candidate.trackName);
  const artist = normalizedMetadata(candidate.artistName);
  if (artist && title.startsWith(`${artist} `)) {
    return title.slice(artist.length).trim();
  }
  return title;
}

const minimumTitleScore = 0.85;
const minimumArtistScore = 0.8;
const minimumTotalScore = 85;

// Scores every candidate on title/artist similarity, agreement on
// "live"/"remix"/"acoustic"-style version markers (so a live recording's
// lyrics don't get matched to the studio track or vice versa), duration
// proximity, and whether it actually has synced lyrics at all — then picks
// the best-scoring one above a confidence floor. This is what replaces
// LavaSrc's own lrcLib integration blindly trusting the first search
// result, and what correctly skips a top-ranked instrumental/alternate
// release in favor of a lower-ranked one that actually has synced lyrics.
function selectBestCandidate(
  title: string,
  artist: string,
  durationMs: number | undefined,
  candidates: readonly LrcLibCandidate[],
): LrcLibCandidate | null {
  let bestScore = -1;
  let best: LrcLibCandidate | null = null;
  const wantVersion = versionMarkerPattern.exec(normalizedMetadata(title))?.[0]?.toLowerCase() ?? null;
  const durationSeconds = durationMs !== undefined ? durationMs / 1000 : undefined;

  for (const candidate of candidates) {
    const titleResult = metadataMatchScore(title, candidateTitle(candidate));
    if (!titleResult.match || titleResult.score < minimumTitleScore) continue;

    const artistResult = artistMatchScore(artist, candidate.artistName);
    if (!artistResult.match) continue;
    if (artist !== "" && artistResult.score < minimumArtistScore) continue;

    let score = titleResult.score * 60 + artistResult.score * 40;

    const gotVersion = versionMarkerPattern.exec(normalizedMetadata(candidate.trackName))?.[0]?.toLowerCase() ?? null;
    if (wantVersion !== gotVersion) continue;
    score += 12;

    if (durationSeconds !== undefined && candidate.duration) {
      const difference = Math.abs(durationSeconds - candidate.duration);
      if (difference > 20) continue;
      score += Math.max(0, 20 - difference / 1.5);
    }

    if (candidate.syncedLyrics?.trim()) {
      score += 8;
    } else if (candidate.plainLyrics?.trim()) {
      score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return bestScore >= minimumTotalScore ? best : null;
}

async function searchLrcLib(trackName: string, artistName: string): Promise<LrcLibCandidate[]> {
  const url = new URL("https://lrclib.net/api/search");
  url.searchParams.set("track_name", trackName);
  if (artistName) url.searchParams.set("artist_name", artistName);
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return lrcLibSearchResponseSchema.parse(await response.json());
}

// Tries each artist-name variant in turn (original metadata first, then any
// title-derived artist, then each individual name split out of a
// multi-artist credit), stopping as soon as a confident match is found
// rather than always exhausting every variant.
export async function fetchSyncedLyrics(
  trackName: string,
  artistName: string,
  durationMs?: number,
): Promise<SyncedLyricLine[] | null> {
  const normalized = normalizeQuery(trackName, artistName);
  // Each search variant carries its own "want" artist to score against.
  // The title-derived artist (e.g. "Owl City" split out of a YouTube title)
  // has no real relationship to the original messy metadata (e.g. the
  // channel name "OwlCityVEVO") — scoring a match found via that variant
  // against the *original* artist would then correctly, but wrongly,
  // reject it. Every other variant is still scored against the original
  // artist string, since artistMatchScore already knows how to split *that*
  // into its own individual-name variants internally.
  const attempts: { searchArtist: string; scoreArtist: string }[] = [];
  if (normalized.extraArtist) {
    attempts.push({ searchArtist: normalized.extraArtist, scoreArtist: normalized.extraArtist });
  }
  for (const variant of artistSearchVariants(normalized.artist)) {
    attempts.push({ searchArtist: variant, scoreArtist: normalized.artist });
  }

  const triedArtists = new Set<string>();
  const candidates: LrcLibCandidate[] = [];
  const seenCandidateKeys = new Set<string>();

  for (const attempt of attempts) {
    const key = attempt.searchArtist.toLowerCase();
    if (triedArtists.has(key)) continue;
    triedArtists.add(key);

    const results = await searchLrcLib(normalized.title, attempt.searchArtist);
    for (const result of results) {
      // LRCLIB's own row id is the only thing that's actually guaranteed
      // unique per release — title/artist/duration alone can genuinely
      // collide across two different albums (a single re-released on a
      // compilation at the exact same duration), and deduping on that
      // composite would then silently discard whichever of the two carries
      // the synced lyrics the other one lacks. Only fall back to the
      // composite key for the rare row with no id.
      const candidateKey = result.id !== undefined
        ? `id:${result.id}`
        : `${result.trackName}|${result.artistName}|${result.duration ?? ""}`;
      if (seenCandidateKeys.has(candidateKey)) continue;
      seenCandidateKeys.add(candidateKey);
      candidates.push(result);
    }

    const best = selectBestCandidate(normalized.title, attempt.scoreArtist, durationMs, candidates);
    if (best?.syncedLyrics) {
      const lines = parseSyncedLyrics(best.syncedLyrics);
      if (lines.length > 0) return lines;
    }
  }

  return null;
}
