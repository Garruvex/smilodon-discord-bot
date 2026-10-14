function calendarDay(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
  const part = (name: string): string => parts.find((item) => item.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function endOfLocalDay(date: string, timeZone: string): number | null {
  const epoch = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== date) return null;
  let lower = epoch - 18 * 3_600_000; let upper = epoch + 48 * 3_600_000;
  while (upper - lower > 1) {
    const middle = Math.floor((upper + lower) / 2);
    if (calendarDay(middle, timeZone) <= date) lower = middle; else upper = middle;
  }
  return lower;
}
export function startOfLocalDay(timestamp: number, timeZone: string): number {
  const date = calendarDay(timestamp, timeZone);
  const previous = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return endOfLocalDay(previous, timeZone)! + 1;
}
