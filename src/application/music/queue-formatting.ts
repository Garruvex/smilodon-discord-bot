import type { MusicTrack } from "../../domain/music/music-track.js";

const trackTitleMaxChars = 60;

export function formatQueueDuration(totalMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(totalMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join("");
}

export function sumTrackDurations(tracks: readonly MusicTrack[]): number {
  return tracks.reduce((total, track) => total + (track.isStream ? 0 : track.durationMs), 0);
}

export function truncateTrackTitle(title: string): string {
  const sanitized = title.replaceAll("[", "").replaceAll("]", "");
  return sanitized.length > trackTitleMaxChars
    ? `${sanitized.slice(0, trackTitleMaxChars - 1)}…`
    : sanitized;
}

// Compact form — one entry per line in a queue list, so a full mention
// phrase per track ("Requested by @x") would eat into the available space
// fast. Just the mention is enough context there.
export function formatQueueTrackRequester(requestedByUserId: string): string {
  return requestedByUserId === "autoqueue" ? " — Autoqueue" : ` — <@${requestedByUserId}>`;
}

export function formatQueueTrackLine(track: MusicTrack, position: number): string {
  const label = truncateTrackTitle(track.title);
  const titleText = track.uri ? `[${label}](${track.uri})` : label;
  return `${position}. ${titleText}${formatQueueTrackRequester(track.requestedByUserId)}`;
}
