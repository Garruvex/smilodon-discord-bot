import { fetchLinkContent } from "../../../infrastructure/net/safe-url-fetch.js";
import { fetchXPost, isXPostUrl } from "../../../infrastructure/net/x-post-fetch.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./chat-tool.js";

interface ReadLinkToolArgs {
  url: string;
}

export class ReadLinkTool implements ChatTool<ReadLinkToolArgs> {
  public readonly name = "read_link";
  public readonly description =
    "Fetches a web page (or X/Twitter post) the user shared or referenced and returns its readable text, " +
    "so you can read, quote, or summarize it. Use this whenever a message contains a link you'd otherwise " +
    "only be able to guess about from the URL text.";
  public readonly parameters = {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", description: "The http(s) URL to fetch and read." },
    },
  };

  public async execute(args: ReadLinkToolArgs, ctx: ChatToolContext): Promise<ChatToolResult> {
    const options = ctx.signal ? { signal: ctx.signal } : {};
    const result = isXPostUrl(args.url)
      ? await fetchXPost(args.url, options)
      : await fetchLinkContent(args.url, options);
    if (!result.ok) return { content: `Could not read that link: ${result.reason}` };
    return { content: JSON.stringify({ url: result.finalUrl, text: result.text }) };
  }
}
