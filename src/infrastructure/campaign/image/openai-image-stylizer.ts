import type { GeneratedImage, PortraitStylizer } from "../../../application/campaign/ports/image-ports.js";
import type { OpenAiImageGeneratorOptions } from "./openai-image-generator.js";

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
    form.set("model", this.options.model);
    form.set("prompt", request.prompt.slice(0, 3_800));
    form.set("n", "1");
    form.set("size", this.options.size ?? "1024x1024");
    // GPT image models always return base64 and reject response_format.
    if (!this.options.model.startsWith("gpt-image-")) form.set("response_format", "b64_json");
    form.set("image", new Blob([new Uint8Array(request.source.bytes)], { type: request.source.mediaType }), `reference.${extensions[request.source.mediaType]}`);
    const response = await fetch(`${this.options.baseUrl}/images/edits`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    if (!response.ok) throw new Error(`The image provider answered ${response.status}.`);
    const body = (await response.json()) as { data?: { b64_json?: string }[] };
    const encoded = body.data?.[0]?.b64_json;
    if (typeof encoded !== "string" || encoded.length === 0) throw new Error("The image provider returned no picture.");
    return { bytes: Buffer.from(encoded, "base64"), mediaType: "image/png" };
  }
}
