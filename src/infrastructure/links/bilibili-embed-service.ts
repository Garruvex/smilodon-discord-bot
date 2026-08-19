import { EmbedBuilder } from "discord.js";
import type { Logger } from "pino";

import type { BilibiliLinkMatch } from "../../domain/links/bilibili-link.js";

interface BilibiliVideoInfo {
  bvid: string;
  title: string;
  pic: string;
  duration: number;
  owner: { name: string };
  stat: { view: number; danmaku: number; like: number };
}

interface BilibiliViewResponse {
  code: number;
  data?: BilibiliVideoInfo;
}

const fetchTimeoutMs = 8_000;
const bvidPattern = /BV[0-9A-Za-z]{10}/;
const bilibiliBrandColor = 0x00A1D6;
// Bilibili's public API rejects requests without a browser-like User-Agent
// and a same-site Referer.
const bilibiliRequestHeaders = {
  "User-Agent": "Mozilla/5.0 (compatible; DiscordBot link preview)",
  Referer: "https://www.bilibili.com/",
};

export class BilibiliEmbedService {
  public constructor(private readonly logger: Logger) {}

  public async buildEmbed(match: BilibiliLinkMatch): Promise<EmbedBuilder | null> {
    const bvid = match.kind === "video" ? match.bvid : await this.resolveShortLink(match.originalUrl);
    if (!bvid) return null;

    const info = await this.fetchVideoInfo(bvid);
    if (!info) return null;

    return new EmbedBuilder()
      .setColor(bilibiliBrandColor)
      .setTitle(info.title.slice(0, 256))
      .setURL(`https://www.bilibili.com/video/${info.bvid}`)
      .setThumbnail(info.pic)
      .setAuthor({ name: info.owner.name })
      .addFields(
        { name: "Views", value: info.stat.view.toLocaleString(), inline: true },
        { name: "Danmaku", value: info.stat.danmaku.toLocaleString(), inline: true },
        { name: "Duration", value: this.formatDuration(info.duration), inline: true },
      )
      .setFooter({ text: "Bilibili" });
  }

  private async resolveShortLink(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: bilibiliRequestHeaders,
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });
      return response.url.match(bvidPattern)?.[0] ?? null;
    } catch (error) {
      this.logger.warn({ error, url }, "Failed to resolve Bilibili short link");
      return null;
    }
  }

  private async fetchVideoInfo(bvid: string): Promise<BilibiliVideoInfo | null> {
    try {
      const response = await fetch(
        `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
        { headers: bilibiliRequestHeaders, signal: AbortSignal.timeout(fetchTimeoutMs) },
      );
      if (!response.ok) return null;
      const body = await response.json() as BilibiliViewResponse;
      if (body.code !== 0 || !body.data) return null;
      return body.data;
    } catch (error) {
      this.logger.warn({ error, bvid }, "Failed to fetch Bilibili video info");
      return null;
    }
  }

  private formatDuration(totalSeconds: number): string {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }
}
