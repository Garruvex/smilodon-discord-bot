import { createCanvas, type Image } from "@napi-rs/canvas";

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to255 = (v: number): string => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

const fallbackPalette: [string, string] = ["#B98CFF", "#7CC6FF"];
const sampleSize = 32;
const minSaturation = 0.15;
const minLightness = 0.08;
const maxLightness = 0.92;
// Hue buckets further apart than this read as visually distinct colors —
// closer than this and a "two-color" gradient looks like one color with
// noise.
const minHueSeparation = 40;

/**
 * Extracts two vivid, distinct accent colors from an avatar image by
 * downscaling it, bucketing pixels by quantized hue, and picking the two
 * most common hue buckets that are far enough apart to read as distinct —
 * then boosting saturation/lightness so muted photo tones still read as
 * vibrant "brand" colors on a dark card, instead of the exact murky photo
 * colors. Falls back to a fixed purple/blue pair for a fully grayscale
 * avatar (no bucket clears the saturation/lightness floor).
 */
export function extractAvatarPalette(image: Image): [string, string] {
  const canvas = createCanvas(sampleSize, sampleSize);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, sampleSize, sampleSize);
  const { data } = ctx.getImageData(0, 0, sampleSize, sampleSize);

  const hueBuckets = new Map<number, { count: number; sSum: number; lSum: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
    if (a < 100) continue;
    const [h, s, l] = rgbToHsl(r, g, b);
    if (s < minSaturation || l < minLightness || l > maxLightness) continue;
    const bucket = Math.round(h / 15) * 15;
    const entry = hueBuckets.get(bucket) ?? { count: 0, sSum: 0, lSum: 0 };
    entry.count += 1;
    entry.sSum += s;
    entry.lSum += l;
    hueBuckets.set(bucket, entry);
  }

  const sorted = [...hueBuckets.entries()].sort((a, b) => b[1].count - a[1].count);
  if (sorted.length === 0) return fallbackPalette;

  const [primaryHue, primaryStats] = sorted[0]!;
  let secondaryHue = primaryHue, secondaryStats = primaryStats;
  for (const [hue, stats] of sorted.slice(1)) {
    const diff = Math.min(Math.abs(hue - primaryHue), 360 - Math.abs(hue - primaryHue));
    if (diff > minHueSeparation) { secondaryHue = hue; secondaryStats = stats; break; }
  }
  // No sufficiently distinct second hue found (a near-monochrome avatar) —
  // synthesize a complementary-ish partner rather than returning a
  // duplicate, so the gradient still has two visibly different stops.
  if (secondaryHue === primaryHue) secondaryHue = (primaryHue + 100) % 360;

  const vividize = (h: number, stats: typeof primaryStats): string => {
    const avgS = stats.sSum / stats.count, avgL = stats.lSum / stats.count;
    return hslToHex(h, Math.max(0.55, Math.min(0.85, avgS + 0.2)), Math.max(0.55, Math.min(0.75, avgL)));
  };

  return [vividize(primaryHue, primaryStats), vividize(secondaryHue, secondaryStats)];
}
