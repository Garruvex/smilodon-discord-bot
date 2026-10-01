import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import type { Logger } from "pino";

import type { ActivityConfiguration } from "../../config/configuration.js";

const activityDirectory = resolve(process.cwd(), "assets", "activity");
const campaignIconDirectory = resolve(process.cwd(), "assets", "emojis", "dnd");
const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
};

export interface ActivityServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createActivityServer(configuration: ActivityConfiguration, logger: Logger, applicationId: string): ActivityServer {
  let server: Server | null = null;

  return {
    start: async (): Promise<void> => {
      if (server !== null) return;
      if (!existsSync(resolve(activityDirectory, "index.html"))) {
        throw new Error(`Activity web assets are missing from ${activityDirectory}.`);
      }
      const instance = createServer((request, response) => respond(request, response, applicationId));
      await new Promise<void>((resolveListen, rejectListen) => {
        instance.once("error", rejectListen);
        instance.listen(configuration.port, configuration.host, () => {
          instance.removeListener("error", rejectListen);
          resolveListen();
        });
      });
      server = instance;
      logger.info({ host: configuration.host, port: configuration.port }, "Activity preview server listening");
    },
    stop: async (): Promise<void> => {
      const instance = server;
      if (instance === null) return;
      server = null;
      await new Promise<void>((resolveClose, rejectClose) => {
        instance.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}

function respond(request: IncomingMessage, response: ServerResponse, applicationId: string): void {
  const headers = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors https://discord.com https://discordapp.com http://localhost:* http://127.0.0.1:*",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { ...headers, Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
    return;
  }
  if (url.pathname === "/healthz") {
    response.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : JSON.stringify({ status: "ok", mode: "preview" }));
    return;
  }
  if (url.pathname === "/activity-config.json") {
    response.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : JSON.stringify({ applicationId }));
    return;
  }

  const isCampaignIcon = /^\/icons\/[a-z-]+\.png$/.test(url.pathname);
  const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = isCampaignIcon
    ? resolve(campaignIconDirectory, relativePath.slice("icons/".length))
    : resolve(activityDirectory, relativePath);
  const allowedRoot = isCampaignIcon ? campaignIconDirectory : activityDirectory;
  if (!filePath.startsWith(`${allowedRoot}${sep}`) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  response.writeHead(200, {
    ...headers,
    "Content-Type": contentTypes[extension] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(filePath).pipe(response);
}
