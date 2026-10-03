import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import type { Logger } from "pino";

import type { ActivityCampaignListingItem, ServiceResult } from "../../application/campaign/campaign-lobby-service.js";
import type { ActivityGameView } from "../../application/campaign/activity-view.js";
import type { CampaignRecord } from "../../application/campaign/ports/campaign-record.js";
import type { CampaignKey } from "../../application/campaign/ports/campaign-store.js";
import type { UserId } from "../../domain/campaign/core/ids.js";
import type { ActivityConfiguration } from "../../config/configuration.js";
import { campaignEn } from "../../application/i18n/messages/campaign-en.js";
import { campaignZhTW } from "../../application/i18n/messages/campaign-zh-TW.js";
import { isLanguage, type Language } from "../../application/i18n/language.js";
import { z } from "zod";
import { abilities } from "../../domain/campaign/rules/effects.js";
import { buildClasses, selectableBuildRaces, type BuildChoices } from "../../domain/campaign/character/character-build.js";
import { skills } from "../../domain/campaign/rules/skills.js";

const activityDirectory = resolve(process.cwd(), "assets", "activity");
const campaignIconDirectory = resolve(process.cwd(), "assets", "emojis", "dnd");
const campaignArtIconDirectory = resolve(process.cwd(), "assets", "campaign", "icons", "svg");
const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
};

export interface ActivityServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ActivityCampaignApi {
  characterCatalog(): unknown;
  listCharacters(userId: UserId): Promise<unknown>;
  getCharacter(userId: UserId, characterId: string): Promise<unknown | null>;
  createCharacter(userId: UserId, build: BuildChoices): Promise<{ readonly kind: "ok"; readonly characterId: string } | { readonly kind: "invalid"; readonly problems: readonly { readonly code: string }[] } | { readonly kind: "full" }>;
  editCharacter(userId: UserId, characterId: string, build: BuildChoices): Promise<{ readonly kind: "ok" } | { readonly kind: "invalid"; readonly problems: readonly { readonly code: string }[] } | { readonly kind: "notFound" }>;
  deleteCharacter(userId: UserId, characterId: string): Promise<boolean>;
  listGames(guildId: string, userId: UserId): Promise<readonly ActivityCampaignListingItem[]>;
  gameForChannel(guildId: string, userId: UserId, channelId: string): Promise<ActivityCampaignListingItem | null>;
  joinLobby(key: CampaignKey, userId: UserId): Promise<ServiceResult<CampaignRecord>>;
  requestJoin(key: CampaignKey, userId: UserId): Promise<ServiceResult<CampaignRecord>>;
  withdrawJoin(key: CampaignKey, userId: UserId): Promise<ServiceResult<CampaignRecord>>;
  // `since` is the token of the snapshot the client already has: when nothing has changed since, no view is built.
  snapshot(key: CampaignKey, userId: UserId, since?: string): Promise<{ readonly kind: "ok"; readonly value: ActivityGameView; readonly token: string } | { readonly kind: "unchanged"; readonly token: string } | { readonly kind: "refused"; readonly reason: string }>;
  act(key: CampaignKey, userId: UserId, input: unknown): Promise<{ readonly kind: "ok" } | { readonly kind: "refused"; readonly reason: string }>;
  image(key: CampaignKey, userId: UserId, kind: "scene" | "character" | "encounter", id: string): Promise<{ readonly bytes: Buffer; readonly mediaType: "image/png" | "image/jpeg" | "image/webp" } | null>;
}

const characterBuildSchema = z.object({
  class: z.enum(buildClasses), race: z.enum(selectableBuildRaces as [typeof selectableBuildRaces[number], ...typeof selectableBuildRaces[number][]]),
  kit: z.string().min(1).max(100),
  abilities: z.object(Object.fromEntries(abilities.map((ability) => [ability, z.number().int().min(3).max(20)])) as Record<typeof abilities[number], z.ZodNumber>),
  skills: z.array(z.enum(skills as [typeof skills[number], ...typeof skills[number][]])).max(18),
  expertise: z.array(z.enum(skills as [typeof skills[number], ...typeof skills[number][]])).max(18),
  name: z.string().max(80), appearance: z.string().max(400), backstory: z.string().max(400),
  raceAbilityChoices: z.array(z.enum(abilities)).optional(), raceSkillChoices: z.array(z.enum(skills as [typeof skills[number], ...typeof skills[number][]])).optional(),
});

interface ActivitySession {
  readonly userId: UserId;
  readonly guildId: string;
  readonly username: string;
  readonly displayName: string;
  readonly launchCampaignId: string | null;
  readonly expiresAt: number;
}

// The game each player last opened, so a reload (the pop-out button restarts the Activity in a new window) goes back to it.
const lastOpenedGames = new Map<string, string>();
const maxRememberedGames = 5000;
function rememberGame(guildId: string, userId: string, campaignId: string): void {
  const key = `${guildId}:${userId}`;
  lastOpenedGames.delete(key);
  lastOpenedGames.set(key, campaignId);
  if (lastOpenedGames.size > maxRememberedGames) lastOpenedGames.delete(lastOpenedGames.keys().next().value as string);
}

const discordApiBase = "https://discord.com/api/v10";
const sessionLifetimeMs = 60 * 60 * 1000;
const maxRequestBodyBytes = 16 * 1024;
const activityCatalogs: Readonly<Record<Language, Readonly<Record<string, string | undefined>>>> = {
  en: campaignEn,
  "zh-TW": campaignZhTW,
  ja: {},
};

export function createActivityServer(
  configuration: ActivityConfiguration,
  logger: Logger,
  applicationId: string,
  clientSecret: string | null,
  campaigns: ActivityCampaignApi,
): ActivityServer {
  let server: Server | null = null;
  const sessions = new Map<string, ActivitySession>();

  return {
    start: async (): Promise<void> => {
      if (server !== null) return;
      if (!existsSync(resolve(activityDirectory, "index.html"))) {
        throw new Error(`Activity web assets are missing from ${activityDirectory}.`);
      }
      const instance = createServer((request, response) => {
        void respond(request, response, applicationId, clientSecret, campaigns, sessions).catch((error: unknown) => {
          logger.error({ err: error, path: request.url }, "Activity request failed");
          if (!response.headersSent) writeJson(response, 500, { error: "serverError" });
          else response.destroy();
        });
      });
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
      sessions.clear();
      await new Promise<void>((resolveClose, rejectClose) => {
        instance.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}

async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  applicationId: string,
  clientSecret: string | null,
  campaigns: ActivityCampaignApi,
  sessions: Map<string, ActivitySession>,
): Promise<void> {
  const headers = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors https://discord.com https://discordapp.com http://localhost:* http://127.0.0.1:*",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/api/activity/session" && request.method === "POST") {
    await createSession(request, response, headers, applicationId, clientSecret, campaigns, sessions);
    return;
  }
  if (url.pathname === "/api/activity/i18n" && request.method === "GET") {
    const requestedLanguage = url.searchParams.get("language");
    const language: Language = isLanguage(requestedLanguage) ? requestedLanguage : "en";
    const dictionary = Object.fromEntries(Object.entries(campaignEn)
      .filter(([key]) => key.startsWith("activity.") || key.startsWith("campaign.chars.kit."))
      .map(([key, english]) => [key, activityCatalogs[language][key] ?? english]));
    return writeJson(response, 200, dictionary, headers);
  }
  if (url.pathname === "/api/activity/games" && request.method === "GET") {
    const session = requireSession(request, sessions);
    if (session === null) return writeJson(response, 401, { error: "unauthorized" }, headers);
    return writeJson(response, 200, { user: { username: session.username, displayName: session.displayName }, games: await campaigns.listGames(session.guildId, session.userId) }, headers);
  }
  if (url.pathname === "/api/activity/characters") {
    const session = requireSession(request, sessions);
    if (session === null) return writeJson(response, 401, { error: "unauthorized" }, headers);
    if (request.method === "GET") return writeJson(response, 200, { characters: await campaigns.listCharacters(session.userId), catalog: campaigns.characterCatalog() }, headers);
    if (request.method === "POST") {
      let body: unknown;
      try { body = await readJsonBody(request); } catch { return writeJson(response, 400, { error: "invalidRequest" }, headers); }
      const parsed = characterBuildSchema.safeParse(body);
      if (!parsed.success) return writeJson(response, 400, { error: "invalidCharacter", problems: parsed.error.issues.map((issue) => ({ code: issue.message })) }, headers);
      const { raceAbilityChoices, raceSkillChoices, ...required } = parsed.data;
      const build: BuildChoices = { ...required, ...(raceAbilityChoices === undefined ? {} : { raceAbilityChoices }), ...(raceSkillChoices === undefined ? {} : { raceSkillChoices }) };
      const result = await campaigns.createCharacter(session.userId, build);
      if (result.kind !== "ok") return writeJson(response, 409, { error: result.kind === "full" ? "characterLibraryFull" : "invalidCharacter", ...("problems" in result ? { problems: result.problems } : {}) }, headers);
      return writeJson(response, 201, { characterId: result.characterId, characters: await campaigns.listCharacters(session.userId) }, headers);
    }
  }
  const characterMatch = url.pathname.match(/^\/api\/activity\/characters\/([a-zA-Z0-9_-]{1,128})$/);
  if (characterMatch !== null && characterMatch[1] !== undefined) {
    const session = requireSession(request, sessions);
    if (session === null) return writeJson(response, 401, { error: "unauthorized" }, headers);
    const characterId = characterMatch[1];
    if (request.method === "GET") {
      const character = await campaigns.getCharacter(session.userId, characterId);
      return character === null ? writeJson(response, 404, { error: "characterMissing" }, headers) : writeJson(response, 200, { character }, headers);
    }
    if (request.method === "DELETE") {
      const removed = await campaigns.deleteCharacter(session.userId, characterId);
      return writeJson(response, removed ? 200 : 404, removed ? { deleted: true } : { error: "characterMissing" }, headers);
    }
    if (request.method === "PUT") {
      let body: unknown;
      try { body = await readJsonBody(request); } catch { return writeJson(response, 400, { error: "invalidRequest" }, headers); }
      const parsed = characterBuildSchema.safeParse(body);
      if (!parsed.success) return writeJson(response, 400, { error: "invalidCharacter" }, headers);
      const { raceAbilityChoices, raceSkillChoices, ...required } = parsed.data;
      const build: BuildChoices = { ...required, ...(raceAbilityChoices === undefined ? {} : { raceAbilityChoices }), ...(raceSkillChoices === undefined ? {} : { raceSkillChoices }) };
      const result = await campaigns.editCharacter(session.userId, characterId, build);
      if (result.kind !== "ok") return writeJson(response, result.kind === "notFound" ? 404 : 409, { error: result.kind === "notFound" ? "characterMissing" : "invalidCharacter" }, headers);
      return writeJson(response, 200, { character: await campaigns.getCharacter(session.userId, characterId) }, headers);
    }
  }

  const imageMatch = url.pathname.match(/^\/api\/activity\/games\/([0-9a-f-]{1,64})\/images\/(scenes|characters|encounters)\/([^/]{1,384})$/i);
  if (imageMatch !== null && imageMatch[1] !== undefined && imageMatch[3] !== undefined && request.method === "GET") {
    const session = requireSession(request, sessions);
    if (session === null) return writeJson(response, 401, { error: "unauthorized" }, headers);
    let imageId: string;
    try { imageId = decodeURIComponent(imageMatch[3]); } catch { return writeJson(response, 400, { error: "invalidRequest" }, headers); }
    if (imageId.length === 0 || imageId.length > 128) return writeJson(response, 400, { error: "invalidRequest" }, headers);
    const kind = imageMatch[2] === "scenes" ? "scene" : imageMatch[2] === "encounters" ? "encounter" : "character";
    const image = await campaigns.image({ guildId: session.guildId, campaignId: imageMatch[1] }, session.userId, kind, imageId);
    if (image === null) return writeJson(response, 404, { error: "imageNotAvailable" }, headers);
    // The picture under an address can be repainted, so clients ask again with the tag they hold.
    const etag = `"${createHash("sha1").update(image.bytes).digest("hex")}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { ...headers, ETag: etag, "Cache-Control": "private, no-store" });
      response.end();
      return;
    }
    response.writeHead(200, { ...headers, "Content-Type": image.mediaType, "Content-Length": String(image.bytes.byteLength), "Cache-Control": "private, no-store", ETag: etag, "Cross-Origin-Resource-Policy": "same-origin" });
    response.end(image.bytes);
    return;
  }

  const tableMatch = url.pathname.match(/^\/api\/activity\/games\/([0-9a-f-]{1,64})\/(table|action)$/i);
  if (tableMatch !== null && tableMatch[1] !== undefined) {
    const session = requireSession(request, sessions);
    if (session === null) return writeJson(response, 401, { error: "unauthorized" }, headers);
    const key: CampaignKey = { guildId: session.guildId, campaignId: tableMatch[1] };
    if (tableMatch[2] === "table" && request.method === "GET") {
      const since = url.searchParams.get("since") ?? undefined;
      const result = await campaigns.snapshot(key, session.userId, since);
      if (result.kind === "refused") return writeJson(response, result.reason === "notFound" ? 404 : 403, { error: result.reason }, headers);
      rememberGame(session.guildId, session.userId, key.campaignId);
      if (result.kind === "unchanged") return writeJson(response, 200, { unchanged: true, token: result.token }, headers);
      return writeJson(response, 200, { snapshot: result.value, token: result.token }, headers);
    }
    if (tableMatch[2] === "action" && request.method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        return writeJson(response, 400, { error: "invalidRequest" }, headers);
      }
      const action = await campaigns.act(key, session.userId, body);
      if (action.kind === "refused") return writeJson(response, 409, { error: action.reason }, headers);
      const snapshot = await campaigns.snapshot(key, session.userId);
      if (snapshot.kind === "refused") return writeJson(response, snapshot.reason === "notFound" ? 404 : 403, { error: snapshot.reason }, headers);
      if (snapshot.kind === "unchanged") return writeJson(response, 200, { unchanged: true, token: snapshot.token }, headers);
      return writeJson(response, 200, { snapshot: snapshot.value, token: snapshot.token }, headers);
    }
  }

  const actionMatch = url.pathname.match(/^\/api\/activity\/games\/([0-9a-f-]{1,64})\/(join|request|withdraw)$/i);
  if (actionMatch !== null && actionMatch[1] !== undefined && request.method === "POST") {
    const session = requireSession(request, sessions);
    if (session === null) return writeJson(response, 401, { error: "unauthorized" }, headers);
    const key: CampaignKey = { guildId: session.guildId, campaignId: actionMatch[1] };
    const result = actionMatch[2] === "join"
      ? await campaigns.joinLobby(key, session.userId)
      : actionMatch[2] === "request"
        ? await campaigns.requestJoin(key, session.userId)
        : await campaigns.withdrawJoin(key, session.userId);
    if (result.kind === "refused") return writeJson(response, 409, { error: result.reason }, headers);
    return writeJson(response, 200, { games: await campaigns.listGames(session.guildId, session.userId) }, headers);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { ...headers, Allow: "GET, HEAD, POST, PUT, DELETE", "Content-Type": "text/plain; charset=utf-8" });
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
  const isCampaignArtIcon = /^\/art-icons\/[a-z-]+\.svg$/.test(url.pathname);
  const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = isCampaignIcon
    ? resolve(campaignIconDirectory, relativePath.slice("icons/".length))
    : isCampaignArtIcon
      ? resolve(campaignArtIconDirectory, relativePath.slice("art-icons/".length))
      : resolve(activityDirectory, relativePath);
  const allowedRoot = isCampaignIcon ? campaignIconDirectory : isCampaignArtIcon ? campaignArtIconDirectory : activityDirectory;
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
  if (isCampaignArtIcon) {
    const svg = readFileSync(filePath, "utf8").replace('<path d="M0 0h512v512H0z"/>', "");
    response.end(request.method === "HEAD" ? undefined : svg);
    return;
  }
  if (request.method === "HEAD") response.end();
  else createReadStream(filePath).pipe(response);
}

async function createSession(
  request: IncomingMessage,
  response: ServerResponse,
  headers: Record<string, string>,
  applicationId: string,
  clientSecret: string | null,
  campaigns: ActivityCampaignApi,
  sessions: Map<string, ActivitySession>,
): Promise<void> {
  if (clientSecret === null) return writeJson(response, 503, { error: "activityAuthNotConfigured" }, headers);
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    return writeJson(response, 400, { error: "invalidRequest" }, headers);
  }
  if (typeof body !== "object" || body === null) return writeJson(response, 400, { error: "invalidRequest" }, headers);
  const { code, guildId, channelId } = body as { code?: unknown; guildId?: unknown; channelId?: unknown };
  if (typeof code !== "string" || code.length < 8 || code.length > 4096 || typeof guildId !== "string" || !/^\d{17,20}$/.test(guildId)) {
    return writeJson(response, 400, { error: "invalidRequest" }, headers);
  }
  if (channelId !== undefined && channelId !== null && (typeof channelId !== "string" || !/^\d{17,20}$/.test(channelId))) {
    return writeJson(response, 400, { error: "invalidRequest" }, headers);
  }

  const tokenResponse = await fetch(`${discordApiBase}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: applicationId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
    }),
  });
  if (!tokenResponse.ok) return writeJson(response, 401, { error: "discordAuthorizationFailed" }, headers);
  const tokenPayload = await tokenResponse.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof tokenPayload.access_token !== "string") return writeJson(response, 401, { error: "discordAuthorizationFailed" }, headers);
  const accessToken = tokenPayload.access_token;

  // This user-scoped endpoint requires `guilds.members.read`; the returned
  // member identity both proves guild access and avoids a second Discord API call.
  const memberResponse = await fetch(`${discordApiBase}/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!memberResponse.ok) return writeJson(response, 403, { error: "notInLaunchGuild" }, headers);
  const member = await memberResponse.json() as { user?: { id?: unknown; username?: unknown; global_name?: unknown } };
  const user = member.user;
  if (user === undefined || typeof user.id !== "string" || !/^\d{17,20}$/.test(user.id)) {
    return writeJson(response, 401, { error: "discordIdentityFailed" }, headers);
  }

  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
  if (sessions.size >= 5000) return writeJson(response, 503, { error: "activityBusy" }, headers);
  const sessionToken = randomBytes(32).toString("base64url");
  const displayName = typeof user.global_name === "string" && user.global_name.length > 0
    ? user.global_name
    : typeof user.username === "string" ? user.username : "Adventurer";
  const channelGame = typeof channelId === "string" ? await campaigns.gameForChannel(guildId, user.id, channelId) : null;
  // Failing that, the game this player last had open, if they are still in it.
  const remembered = lastOpenedGames.get(`${guildId}:${user.id}`);
  const launchGame = channelGame ?? (remembered === undefined ? null : (await campaigns.listGames(guildId, user.id)).find((game) => game.campaignId === remembered && (game.action === "resume" || game.action === "continue")) ?? null);
  sessions.set(sessionToken, {
    userId: user.id,
    guildId,
    username: typeof user.username === "string" ? user.username : displayName,
    displayName,
    launchCampaignId: launchGame?.campaignId ?? null,
    expiresAt: now + sessionLifetimeMs,
  });
  writeJson(response, 200, {
    access_token: accessToken,
    session_token: sessionToken,
    user: { id: user.id, username: typeof user.username === "string" ? user.username : displayName, displayName },
    launchCampaignId: launchGame?.campaignId ?? null,
  }, headers);
}

function requireSession(request: IncomingMessage, sessions: Map<string, ActivitySession>): ActivitySession | null {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  const session = sessions.get(token);
  if (session === undefined) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk as Uint8Array;
    size += bytes.byteLength;
    if (size > maxRequestBodyBytes) throw new Error("Request body too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    ...headers,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}
