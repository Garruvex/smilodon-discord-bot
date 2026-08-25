// Adapted from seek-command.ts's shorthand parser, extended with a `d`
// (days) unit and shared here since /remind needs it in two places: parsing
// the `duration` option and formatting "time remaining" in /remind list.
const shorthandPattern = /^(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/i;

export function parseDurationMs(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const match = shorthandPattern.exec(trimmed);
  if (!match || !(match[1] ?? match[2] ?? match[3] ?? match[4])) return null;

  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000;
}
