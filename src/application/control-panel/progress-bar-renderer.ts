import type {
  CustomProgressBarTheme,
  ProgressBarEmojiReference,
  ProgressBarSettings,
} from "../../config/guild-configuration.js";

export interface ProgressBarRenderInput {
  positionMs: number;
  durationMs: number;
  paused: boolean;
  isStream: boolean;
  settings: ProgressBarSettings;
  presetTheme?: CustomProgressBarTheme | null;
  isEmojiAvailable?: (emojiId: string) => boolean;
}

export function renderProgressBar(input: ProgressBarRenderInput): string {
  if (input.isStream) return "`LIVE 🔴`";

  const time = `\`${formatDuration(input.positionMs)}\` / \`${formatDuration(input.durationMs)}\``;
  if (input.settings.style === "none") return time;

  const ratio = input.durationMs > 0
    ? Math.min(1, Math.max(0, input.positionMs / input.durationMs))
    : 0;
  const length = Math.min(16, Math.max(6, input.settings.length));
  const markerIndex = Math.min(length - 1, Math.floor(ratio * length));

  const requestedTheme = input.settings.style === "yohta"
    ? input.presetTheme ?? null
    : input.settings.style === "custom"
      ? input.settings.customTheme
      : null;

  const availableTheme = requestedTheme && isThemeAvailable(
    requestedTheme,
    input.isEmojiAvailable,
  )
    ? requestedTheme
    : null;
  const bar = availableTheme
    ? renderEmojiBar(availableTheme, markerIndex, length, input.paused)
    : renderStandardBar(markerIndex, length, input.paused);

  return `${bar}\n${time}`;
}

function isThemeAvailable(
  theme: CustomProgressBarTheme,
  isEmojiAvailable: ((emojiId: string) => boolean) | undefined,
): boolean {
  if (!isEmojiAvailable) return true;
  return [theme.completed, theme.remaining, theme.playing, theme.paused, theme.ending]
    .filter((emoji): emoji is ProgressBarEmojiReference => emoji !== null)
    .every((emoji) => isEmojiAvailable(emoji.id));
}

function renderEmojiBar(
  theme: CustomProgressBarTheme,
  markerIndex: number,
  length: number,
  paused: boolean,
): string {
  return [
    formatEmoji(theme.completed).repeat(markerIndex),
    formatEmoji(paused ? theme.paused : theme.playing),
    formatEmoji(theme.remaining).repeat(length - markerIndex - 1),
    theme.ending ? formatEmoji(theme.ending) : "",
  ].join("");
}

function renderStandardBar(markerIndex: number, length: number, paused: boolean): string {
  return `${"▰".repeat(markerIndex)}${paused ? "⏸" : "◆"}${"▱".repeat(length - markerIndex - 1)}`;
}

function formatEmoji(emoji: ProgressBarEmojiReference): string {
  return `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}
