import type { GeneratedImage, ImageGenerator } from "../../../application/campaign/ports/image-ports.js";

export interface OpenAiImageGeneratorOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly size?: string;
}

// OpenAI's image endpoint (also served by compatible providers). The picture
// comes back inline as base64 so nothing is fetched from a returned URL.
export class OpenAiImageGenerator implements ImageGenerator {
  public constructor(private readonly options: OpenAiImageGeneratorOptions) {}

  public async generate(request: { readonly prompt: string; readonly timeoutMs: number }): Promise<GeneratedImage> {
    const response = await fetch(`${this.options.baseUrl}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        model: this.options.model,
        prompt: request.prompt.slice(0, 3_800),
        n: 1,
        size: this.options.size ?? "1024x1024",
        // GPT image models always return base64 and reject response_format.
        ...(this.options.model.startsWith("gpt-image-") ? {} : { response_format: "b64_json" }),
      }),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    if (!response.ok) throw new Error(`The image provider answered ${response.status}.`);
    const body = (await response.json()) as { data?: { b64_json?: string }[] };
    const encoded = body.data?.[0]?.b64_json;
    if (typeof encoded !== "string" || encoded.length === 0) throw new Error("The image provider returned no picture.");
    return { bytes: Buffer.from(encoded, "base64"), mediaType: "image/png" };
  }
}
