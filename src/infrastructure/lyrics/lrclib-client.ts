import { Converter } from "opencc-js/t2cn";
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
type LrcLibCandidate = z.infer<typeof lrcLibCandidateSchema>;

// A line can carry several timestamps ("[00:01.00][00:31.00]Chorus") when
// the same lyric repeats — each one is its own occurrence of that line.
const lrcLineExpression = /^((?:\[\d+:\d+(?:\.\d+)?\])+)(.*)$/;
const lrcTimestampExpression = /\[(\d+):(\d+(?:\.\d+)?)\]/g;

function parseSyncedLyrics(syncedLyrics: string): SyncedLyricLine[] {
  const lines: SyncedLyricLine[] = [];
  for (const rawLine of syncedLyrics.split("\n")) {
    const match = lrcLineExpression.exec(rawLine.trim());
    if (!match?.[1]) continue;
    const text = match[2]?.trim();
    if (!text) continue;
    for (const timestamp of match[1].matchAll(lrcTimestampExpression)) {
      const minutes = Number(timestamp[1]);
      const seconds = Number(timestamp[2]);
      lines.push({ timestampMs: Math.round((minutes * 60 + seconds) * 1000), line: text });
    }
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
const metadataSuffixPattern = /\s*[[(【](?:official\s+)?(?:(?:music\s+)?video(?:\s+clip)?|mv|audio|lyrics?|lyric\s+video|visuali[sz]er)[\])】]/gi;
// The same suffixes without brackets, trailing after a dash or pipe — Asian
// label uploads often write "…】-Official Music Video" or "… | Official MV".
const trailingMetadataPattern = /\s*[-–—|]\s*(?:official\s+)?(?:(?:music\s+)?video|mv|audio|lyrics?(?:\s+video)?|visuali[sz]er)\s*$/i;
const artistTitleSeparatorPattern = /\s+[-–—]\s+/;
// "周杰倫 Jay Chou【夜曲 Nocturne】" — the CJK-upload counterpart of
// "Artist - Title": the artist outside, the title inside the brackets.
const bracketedTitlePattern = /^(.+?)\s*[【《]([^】》]+)[】》]$/;
// Japanese channels publish collaboration headlines as
// "Artist｢Track｣ × TV Anime｢Show｣ …" — the first quoted part is the track,
// but only trusted when the text before it is the credited artist, since
// quotes just as often wrap an anime or show name.
const japaneseQuotedTitlePattern = /[｢「『]([^｣」』]+)[｣」』]/;

// LRCLIB rows for the same Chinese song are catalogued in either
// Traditional or Simplified script (周杰倫 vs 周杰伦); comparing everything
// in Simplified makes the two spellings equal instead of a mismatch.
// opencc-js ships .d.ts files with extensionless relative imports, which
// NodeNext resolution can't follow — so its types resolve to nothing and the
// one function used here is typed by hand.
type TextConverterFactory = (options: { from: "t"; to: "cn" }) => (text: string) => string;
const toSimplifiedChinese = (Converter as TextConverterFactory)({ from: "t", to: "cn" });
const nonWordPattern = /[^\p{L}\p{N}]+/gu;
const versionMarkerPattern = /\b(live|remix|acoustic|instrumental|karaoke|demo|edit|version|cover|sped ?up|slowed)\b/i;
// Splits a multi-artist credit ("Owl City, Carly Rae Jepsen", "A feat. B")
// into individual names — LRCLIB indexes duet/feature tracks under all
// sorts of artist-string spellings, so trying each artist alone
// significantly widens what can match.
const artistSeparatorPattern = /\s*(?:,|&|\/|;|、|，|\bfeat(?:uring)?\.?\b|\bft\.?\b|和|與|与)\s*/gi;

function stripMetadataSuffix(value: string): string {
  return value.replace(metadataSuffixPattern, " ").trim().replace(trailingMetadataPattern, "").trim();
}

interface NormalizedQuery {
  readonly title: string;
  readonly artist: string;
  // A YouTube-style title ("Artist - Title (Official Video)") often carries
  // a more reliable artist credit than the channel/author metadata — kept
  // as an extra candidate rather than replacing the original outright, so a
  // bad split can't make matching strictly worse than not normalizing at all.
  readonly extraArtist: string | null;
  // The unsplit title, kept whenever the "Artist - Title" split fired — a
  // real title can contain " - " itself ("Good Time - Live"), and searching
  // only the split halves would then never look for it at all.
  readonly unsplitTitle: string | null;
}

// Strips "(Official Video)"-style suffixes and splits an "Artist - Title"
// prefix. lyricsCacheIdentity reuses it so re-uploads of the same song with
// differently-formatted video titles share one cache entry.
function normalizeQuery(title: string, artist: string): NormalizedQuery {
  const trimmedTitle = title.trim();
  const trimmedArtist = artist.trim();
  const cleanTitle = stripMetadataSuffix(trimmedTitle);
  const quotedMatch = japaneseQuotedTitlePattern.exec(cleanTitle);
  const quotedTitle = quotedMatch?.[1]?.trim();
  if (quotedMatch && quotedTitle) {
    const prefix = cleanTitle.slice(0, quotedMatch.index).trim();
    if (prefix && artistMatchScore(trimmedArtist, prefix).score >= minimumArtistScore) {
      return { title: quotedTitle, artist: trimmedArtist, extraArtist: null, unsplitTitle: cleanTitle };
    }
  }
  const bracketMatch = bracketedTitlePattern.exec(cleanTitle);
  const bracketArtist = bracketMatch?.[1]?.trim();
  const bracketTitle = bracketMatch?.[2]?.trim();
  if (bracketArtist && bracketTitle) {
    return { title: bracketTitle, artist: trimmedArtist, extraArtist: bracketArtist, unsplitTitle: cleanTitle };
  }
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
      return { title: derivedTitle, artist: trimmedArtist, extraArtist: derivedArtist, unsplitTitle: cleanTitle };
    }
  }
  return { title: cleanTitle, artist: trimmedArtist, extraArtist: null, unsplitTitle: null };
}

// The title/artist a cache entry is keyed on. Both the title-derived artist
// and the original artist feed into matching, so both belong in the key —
// keying on only one lets two lookups that can resolve to different lyrics
// share (and overwrite) a single entry.
export function lyricsCacheIdentity(title: string, artist: string): { title: string; artist: string } {
  const normalized = normalizeQuery(title, artist);
  return {
    title: normalized.title,
    artist: normalized.extraArtist ? `${normalized.extraArtist} | ${normalized.artist}` : normalized.artist,
  };
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
  const lowered = stripMetadataSuffix(toSimplifiedChinese(value).toLowerCase());
  return lowered.replace(nonWordPattern, " ").trim();
}

interface MatchResult {
  readonly score: number;
  readonly match: boolean;
}

// Scripts written with spaces between words. Inside them a containment
// match must land on word boundaries ("Heart" is not "Heartless"); scripts
// like Japanese or Chinese have no spaces to find a boundary at, so a plain
// substring is the best signal available there.
const spacedScriptCharacter = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]/u;

function containsAsWords(haystack: string, needle: string): boolean {
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) {
    const before = haystack[index - 1];
    const after = haystack[index + needle.length];
    const first = needle[0] ?? "";
    const last = needle[needle.length - 1] ?? "";
    const leftOk = before === undefined || before === " "
      || !spacedScriptCharacter.test(before) || !spacedScriptCharacter.test(first);
    const rightOk = after === undefined || after === " "
      || !spacedScriptCharacter.test(after) || !spacedScriptCharacter.test(last);
    if (leftOk && rightOk) return true;
  }
  return false;
}

function metadataMatchScore(want: string, got: string): MatchResult {
  const normalizedWant = normalizedMetadata(want);
  const normalizedGot = normalizedMetadata(got);
  if (normalizedWant === "") return { score: 0, match: true };
  if (normalizedGot === "") return { score: 0, match: false };
  if (normalizedWant === normalizedGot) return { score: 1, match: true };
  if (containsAsWords(normalizedWant, normalizedGot) || containsAsWords(normalizedGot, normalizedWant)) {
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

// Some providers prefix the track title with the artist name; also try it
// stripped so title comparison isn't penalized for a prefix that isn't
// really part of the title. The unstripped title stays a candidate too —
// a title can genuinely start with the artist's name ("Talk Talk" by Talk).
function candidateTitles(candidate: LrcLibCandidate): string[] {
  const title = normalizedMetadata(candidate.trackName);
  const artist = normalizedMetadata(candidate.artistName);
  if (artist && title.startsWith(`${artist} `)) {
    return [title, title.slice(artist.length).trim()];
  }
  return [title];
}

function titleMatchScore(want: string, candidate: LrcLibCandidate): MatchResult {
  let best: MatchResult = { score: 0, match: false };
  for (const title of candidateTitles(candidate)) {
    const result = metadataMatchScore(want, title);
    if (result.match && (!best.match || result.score > best.score)) best = result;
  }
  return best;
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
interface ScoredCandidate {
  readonly lines: SyncedLyricLine[];
  readonly score: number;
}

function selectBestCandidate(
  title: string,
  artist: string,
  durationMs: number | undefined,
  candidates: readonly LrcLibCandidate[],
): ScoredCandidate | null {
  let bestScore = -1;
  let bestLines: SyncedLyricLine[] | null = null;
  const wantVersion = versionMarkerPattern.exec(normalizedMetadata(title))?.[0]?.toLowerCase() ?? null;
  const durationSeconds = durationMs !== undefined ? durationMs / 1000 : undefined;

  for (const candidate of candidates) {
    // Only usable synced results can win. A plain-only row can otherwise
    // outscore a synced row on duration, and malformed LRC can win the
    // ranking only to parse into an empty result afterward.
    const lines = candidate.syncedLyrics ? parseSyncedLyrics(candidate.syncedLyrics) : [];
    if (lines.length === 0) continue;
    const titleResult = titleMatchScore(title, candidate);
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

    if (score > bestScore) {
      bestScore = score;
      bestLines = lines;
    }
  }

  return bestLines && bestScore >= minimumTotalScore ? { lines: bestLines, score: bestScore } : null;
}

async function searchLrcLib(trackName: string, artistName: string): Promise<LrcLibCandidate[]> {
  const url = new URL("https://lrclib.net/api/search");
  url.searchParams.set("track_name", trackName);
  if (artistName) url.searchParams.set("artist_name", artistName);
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error("Invalid LRCLIB search response");
  const candidates: LrcLibCandidate[] = [];
  for (const entry of payload) {
    const parsed = lrcLibCandidateSchema.safeParse(entry);
    if (parsed.success) candidates.push(parsed.data);
  }
  // A single malformed row should not discard valid rows, but a wholly
  // invalid response is an upstream error, not a cacheable "no lyrics".
  if (payload.length > 0 && candidates.length === 0) {
    throw new Error("Invalid LRCLIB search candidates");
  }
  return candidates;
}

// Fires a search for every artist-name variant (original metadata, any
// title-derived artist, each individual name split out of a multi-artist
// credit) concurrently rather than one at a time. A multi-artist credit can
// mean 2-4 variants, and this used to await them sequentially — a slow or
// empty response for the first variant (each request carries its own 5s
// timeout) delayed ever trying the others, so a track that only matched on
// the third or fourth variant could take up to their combined wait before
// the panel had anything to show. Firing them together bounds the total wait
// to the single slowest request instead of their sum.
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
  const attempts: { title: string; searchArtist: string; scoreArtist: string }[] = [];
  if (normalized.extraArtist) {
    attempts.push({ title: normalized.title, searchArtist: normalized.extraArtist, scoreArtist: normalized.extraArtist });
  }
  for (const variant of artistSearchVariants(normalized.artist)) {
    attempts.push({ title: normalized.title, searchArtist: variant, scoreArtist: normalized.artist });
  }
  // The split may have been wrong ("Good Time - Live" is a title, not
  // "Good Time" the artist) — also look up the unsplit title under the
  // original artist, plus an artist-less search that the multi-artist
  // scoring can still sort through.
  if (normalized.unsplitTitle) {
    for (const searchArtist of new Set([normalized.artist, ""])) {
      attempts.push({ title: normalized.unsplitTitle, searchArtist, scoreArtist: normalized.artist });
    }
  }
  // LRCLIB's search matches the script it's given, so a Traditional title
  // never surfaces a row catalogued only in Simplified. Scoring already
  // treats the two as equal; this just gets those rows into the pool.
  const simplifiedTitle = toSimplifiedChinese(normalized.title);
  if (simplifiedTitle !== normalized.title) {
    attempts.push({ title: simplifiedTitle, searchArtist: "", scoreArtist: normalized.extraArtist ?? normalized.artist });
  }

  const seenAttempts = new Set<string>();
  const uniqueAttempts = attempts.filter((attempt) => {
    const key = `${attempt.title}|${attempt.searchArtist}`.toLowerCase();
    if (seenAttempts.has(key)) return false;
    seenAttempts.add(key);
    return true;
  });

  const settledResults = await Promise.allSettled(
    uniqueAttempts.map((attempt) => searchLrcLib(attempt.title, attempt.searchArtist)),
  );
  const resultSets = settledResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const failure = settledResults.find((result) => result.status === "rejected");
  // A partial outage must not hide a result from another variant. If every
  // request failed, propagate the failure so the caller won't cache a false
  // "no lyrics" result.
  if (resultSets.length === 0) {
    throw failure?.reason ?? new Error("LRCLIB search failed");
  }

  const seenCandidateKeys = new Set<string>();
  const candidates: LrcLibCandidate[] = [];
  for (const results of resultSets) {
    for (const result of results) {
      // LRCLIB's own row id is the only thing that's actually guaranteed
      // unique per release — title/artist/duration alone can genuinely
      // collide across two different albums (a single re-released on a
      // compilation at the exact same duration), and deduping on that
      // composite would then silently discard whichever of the two carries
      // the synced lyrics the other one lacks. The rare row with no id falls
      // back to a composite key that includes the lyrics themselves for
      // exactly that reason.
      const candidateKey = result.id !== undefined
        ? `id:${result.id}`
        : JSON.stringify([result.trackName, result.artistName, result.duration ?? null, result.syncedLyrics ?? null]);
      if (seenCandidateKeys.has(candidateKey)) continue;
      seenCandidateKeys.add(candidateKey);
      candidates.push(result);
    }
  }

  // Every variant scores the *same* merged candidate pool against its own
  // notion of "the real artist" — the overall best-scoring result across
  // all of them wins, rather than whichever variant happened to be tried
  // first (there's no longer a "first" — they all ran together).
  const scoringPairs = new Map(uniqueAttempts.map((attempt) => [
    `${attempt.title}|${attempt.scoreArtist}`,
    { title: attempt.title, artist: attempt.scoreArtist },
  ]));
  let best: ScoredCandidate | null = null;
  for (const { title, artist } of scoringPairs.values()) {
    const result = selectBestCandidate(title, artist, durationMs, candidates);
    if (result && (!best || result.score > best.score)) best = result;
  }

  if (best) return best.lines;
  // An empty result from the surviving variants is inconclusive when any
  // variant failed. Let playback use its plugin fallback, but do not persist
  // a negative cache entry that would suppress future retries.
  if (failure) throw failure.reason;
  return null;
}
