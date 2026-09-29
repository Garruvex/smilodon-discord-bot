import type { GeneratedImage, ImageAspect, ImageGenerator } from "../../../application/campaign/ports/image-ports.js";
import { imageFields, readImage, type OpenAiImageGeneratorOptions } from "./openai-image-http.js";

export type { OpenAiImageGeneratorOptions } from "./openai-image-http.js";

// OpenAI's image endpoint (also served by compatible providers). The picture
// comes back inline as base64 so nothing is fetched from a returned URL.
export class OpenAiImageGenerator implements ImageGenerator {
  public constructor(private readonly options: OpenAiImageGeneratorOptions) {}

  public async generate(request: { readonly prompt: string; readonly aspect?: ImageAspect; readonly timeoutMs: number }): Promise<GeneratedImage> {
    const response = await fetch(`${this.options.baseUrl}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({ ...imageFields(this.options, request.aspect), n: 1, prompt: request.prompt.slice(0, 3_800) }),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    return readImage(response);
  }
}
