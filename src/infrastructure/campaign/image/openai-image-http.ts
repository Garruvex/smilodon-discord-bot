import { sniffImageType } from "../../../application/campaign/images/image-bytes.js";
import { ImageProviderError, type GeneratedImage, type ImageAspect } from "../../../application/campaign/ports/image-ports.js";

// The campaign's own connection to an image model. Its key, address and model
// are the CAMPAIGN_IMAGE_* settings and nothing the chat personality uses.
export interface OpenAiImageGeneratorOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  // Fixed size for every picture; absent: chosen from the picture's shape and the model.
  readonly size?: string;
  // "low" | "medium" | "high" | "auto" for GPT image models; absent: the provider's default.
  readonly quality?: string;
}

const isGptImage = (model: string): boolean => model.startsWith("gpt-image-");

// The size a model offers for a shape. Models this does not know get a square,
// which every image model accepts.
export function sizeFor(options: OpenAiImageGeneratorOptions, aspect: ImageAspect | undefined): string {
  if (options.size !== undefined) return options.size;
  if (aspect === undefined || aspect === "square") return "1024x1024";
  if (isGptImage(options.model)) return aspect === "wide" ? "1536x1024" : "1024x1536";
  if (options.model.startsWith("dall-e-3")) return aspect === "wide" ? "1792x1024" : "1024x1792";
  return "1024x1024";
}

// The fields both endpoints (generate, edit) take.
export function imageFields(options: OpenAiImageGeneratorOptions, aspect: ImageAspect | undefined): Record<string, string> {
  return {
    model: options.model,
    n: "1",
    size: sizeFor(options, aspect),
    // GPT image models always return base64 and reject response_format.
    ...(isGptImage(options.model) ? {} : { response_format: "b64_json" }),
    ...(options.quality !== undefined && isGptImage(options.model) ? { quality: options.quality } : {}),
  };
}

// What a provider's error body says, short and without anything that looks like a key.
async function reason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown; code?: unknown } };
    const message = typeof body.error?.message === "string" ? body.error.message : "";
    const code = typeof body.error?.code === "string" ? body.error.code : "";
    return `${code} ${message}`.replace(/sk-[A-Za-z0-9_-]+/g, "[key]").replace(/\s+/g, " ").trim().slice(0, 200);
  } catch {
    return "";
  }
}

// Reads a provider's answer: a picture, or an ImageProviderError that says whether trying again could help.
export async function readImage(response: Response): Promise<GeneratedImage> {
  if (!response.ok) {
    const why = await reason(response);
    // A rate limit or a server error may pass; a 4xx the provider stands by will not.
    const retryable = response.status === 429 || response.status >= 500 || response.status === 408;
    throw new ImageProviderError(`The image provider answered ${response.status}${why === "" ? "" : `: ${why}`}.`, retryable);
  }
  const body = (await response.json()) as { data?: { b64_json?: string }[] };
  const encoded = body.data?.[0]?.b64_json;
  if (typeof encoded !== "string" || encoded.length === 0) throw new ImageProviderError("The image provider returned no picture.", true);
  const bytes = Buffer.from(encoded, "base64");
  // Whatever the provider says, only a real picture goes on.
  const mediaType = sniffImageType(bytes);
  if (mediaType === undefined) throw new ImageProviderError("The image provider returned something that is not a picture.", true);
  return { bytes, mediaType };
}
