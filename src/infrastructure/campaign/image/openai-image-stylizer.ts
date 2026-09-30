import type { GeneratedImage, PortraitStylizer } from "../../../application/campaign/ports/image-ports.js";
import { imageFields, readImage, type OpenAiImageGeneratorOptions } from "./openai-image-http.js";

const extensions: Readonly<Record<GeneratedImage["mediaType"], string>> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

// OpenAI's image edit endpoint (also served by compatible providers): the
// player's picture goes in as the reference and the prompt says what to make
// of it. The result comes back inline as base64, so nothing is fetched from a
// returned URL. The upload is sent to the provider for this one request and
// is not written anywhere by this class.
export class OpenAiImageStylizer implements PortraitStylizer {
  public constructor(private readonly options: OpenAiImageGeneratorOptions) {}

  public async stylize(request: { readonly source: GeneratedImage; readonly prompt: string; readonly timeoutMs: number }): Promise<GeneratedImage> {
    const form = new FormData();
    for (const [field, value] of Object.entries(imageFields(this.options, "square"))) form.set(field, value);
    form.set("prompt", request.prompt.slice(0, 3_800));
    form.set("image", new Blob([new Uint8Array(request.source.bytes)], { type: request.source.mediaType }), `reference.${extensions[request.source.mediaType]}`);
    const response = await fetch(`${this.options.baseUrl}/images/edits`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    return readImage(response);
  }
}
