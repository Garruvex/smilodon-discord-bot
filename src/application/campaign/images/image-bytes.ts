import type { GeneratedImage } from "../ports/image-ports.js";

// What a picture really is, from its first bytes and not from what it claims
// to be; undefined for anything that is not a PNG, JPEG or WebP picture.
export function sniffImageType(bytes: Uint8Array): GeneratedImage["mediaType"] | undefined {
  const at = (index: number): number => bytes[index] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  const riff = String.fromCharCode(at(0), at(1), at(2), at(3));
  const webp = String.fromCharCode(at(8), at(9), at(10), at(11));
  return riff === "RIFF" && webp === "WEBP" ? "image/webp" : undefined;
}
