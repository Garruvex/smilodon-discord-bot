import { activityActions, type ActivityFieldType } from "./activity-api-contract.js";

type Method = "get" | "post" | "put" | "delete";
interface Route {
  readonly method: Method;
  readonly path: string;
  readonly summary: string;
  readonly group: string;
  readonly public?: boolean;
  readonly body?: Record<string, unknown>;
}

const id = { name: "campaignId", in: "path", required: true, schema: { type: "string" } };
const characterId = { name: "characterId", in: "path", required: true, schema: { type: "string" } };
const errorResponse = { description: "Error: { error: string }" };
const response = (description: string): Record<string, unknown> => ({
  "200": { description },
  "400": errorResponse,
  "401": errorResponse,
  "403": errorResponse,
  "404": errorResponse,
  "409": errorResponse,
});

function fieldSchema(type: ActivityFieldType): Record<string, unknown> {
  if (type === "string") return { type: "string" };
  if (type === "integer") return { type: "integer" };
  if (type === "boolean") return { type: "boolean" };
  if (type === "string[]") return { type: "array", items: { type: "string" } };
  if (type === "ability") return { type: "string", enum: ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"] };
  if (type === "ability[]") return { type: "array", items: fieldSchema("ability") };
  if (type === "string|null") return { type: "string", nullable: true };
  if (type === "integer|null") return { type: "integer", nullable: true };
  return { type: "string", enum: type.split("|") };
}

function actionSchema(kind: keyof typeof activityActions, fields: Readonly<Record<string, ActivityFieldType>>): Record<string, unknown> {
  const properties: Record<string, unknown> = { kind: { type: "string", enum: [kind] } };
  const required = ["kind"];
  for (const [rawName, type] of Object.entries(fields)) {
    const optional = rawName.endsWith("?");
    const name = optional ? rawName.slice(0, -1) : rawName;
    properties[name] = fieldSchema(type);
    if (!optional) required.push(name);
  }
  return { title: kind, type: "object", properties, required, additionalProperties: true };
}

export const activityRoutes: readonly Route[] = [
  { method: "post", path: "/api/activity/session", summary: "Exchange a Discord Activity authorization code for a session", group: "Session", public: true, body: { code: "Discord authorization code", guildId: "Discord guild ID", channelId: "Optional launch channel ID" } },
  { method: "get", path: "/api/activity/i18n", summary: "Activity text catalog for a language", group: "Session", public: true },
  { method: "get", path: "/api/activity/games", summary: "Games visible to the signed-in player", group: "Games" },
  { method: "post", path: "/api/activity/games", summary: "Create a game table", group: "Games", body: { name: "string", language: "en or zh-TW", adventureId: "string", pacing: "live or playByPost", players: "1–6", visibility: "open or membersOnly", joinAsPlayer: "boolean", lootGold: "optional pooled or split" } },
  { method: "get", path: "/api/activity/table-options", summary: "Available adventures and table choices", group: "Games" },
  { method: "get", path: "/api/activity/games/{campaignId}/manage", summary: "Organizer management view", group: "Games" },
  { method: "post", path: "/api/activity/games/{campaignId}/manage", summary: "Invite, approve, resize, or remove", group: "Games", body: { kind: "invite, decide, resize, or remove" } },
  { method: "get", path: "/api/activity/games/{campaignId}/invite-members", summary: "Search eligible server members (?q=)", group: "Games" },
  { method: "get", path: "/api/activity/characters", summary: "Player's saved characters and build catalog", group: "Characters" },
  { method: "post", path: "/api/activity/characters", summary: "Create a saved character", group: "Characters", body: { name: "string", class: "class ID", race: "race ID", kit: "kit ID", abilities: "ability scores", skills: "skill IDs", expertise: "skill IDs", appearance: "string", backstory: "string" } },
  { method: "get", path: "/api/activity/characters/{characterId}", summary: "Read one saved character", group: "Characters" },
  { method: "put", path: "/api/activity/characters/{characterId}", summary: "Edit one saved character", group: "Characters", body: { name: "string", class: "class ID", race: "race ID", kit: "kit ID", abilities: "ability scores", skills: "skill IDs", expertise: "skill IDs", appearance: "string", backstory: "string" } },
  { method: "delete", path: "/api/activity/characters/{characterId}", summary: "Delete one saved character", group: "Characters" },
  { method: "get", path: "/api/activity/characters/{characterId}/portrait", summary: "Read a saved character portrait", group: "Characters" },
  { method: "get", path: "/api/activity/games/{campaignId}/images/{kind}/{imageId}", summary: "Read authorized scene, encounter, or character art", group: "Game table" },
  { method: "get", path: "/api/activity/games/{campaignId}/table", summary: "Read the player-specific game snapshot (?since=token)", group: "Game table" },
  { method: "post", path: "/api/activity/games/{campaignId}/action", summary: "Perform one game action", group: "Game table" },
  { method: "post", path: "/api/activity/games/{campaignId}/join", summary: "Join an open lobby", group: "Game table" },
  { method: "post", path: "/api/activity/games/{campaignId}/request", summary: "Request to join a running game", group: "Game table" },
  { method: "post", path: "/api/activity/games/{campaignId}/withdraw", summary: "Withdraw a join request", group: "Game table" },
  { method: "get", path: "/activity-config.json", summary: "Public Discord application ID", group: "Service", public: true },
  { method: "get", path: "/healthz", summary: "Activity server health", group: "Service", public: true },
];

export function activityOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of activityRoutes) {
    const parameters = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] === "campaignId" ? id : match[1] === "characterId" ? characterId : { name: match[1], in: "path", required: true, schema: { type: "string" } });
    const body = route.path.endsWith("/action")
      ? { content: { "application/json": { schema: { oneOf: Object.entries(activityActions).map(([kind, fields]) => actionSchema(kind as keyof typeof activityActions, fields)), discriminator: { propertyName: "kind" } } } } }
      : route.body === undefined ? undefined : { content: { "application/json": { schema: { type: "object", description: JSON.stringify(route.body) } } } };
    const operations = paths[route.path] ??= {};
    operations[route.method] = {
      operationId: route.method + route.path.replace(/[^a-zA-Z0-9]+/g, "_"),
      tags: [route.group],
      summary: route.summary,
      ...(route.public === true ? { security: [] } : { security: [{ activitySession: [] }] }),
      ...(parameters.length === 0 ? {} : { parameters }),
      ...(body === undefined ? {} : { requestBody: { required: true, ...body } }),
      responses: response(route.method === "get" ? "Requested data or an unchanged snapshot" : "Action result or updated snapshot"),
    };
  }
  return {
    openapi: "3.0.3",
    info: { title: "FNTU D&D Activity API", version: "1.0.0", description: "Local development reference. A session is created using the Discord Activity SDK; game reads and writes are authorized again for the session user." },
    servers: [{ url: "http://127.0.0.1:3000", description: "Default local Activity server; your configured port may differ" }],
    components: { securitySchemes: { activitySession: { type: "http", scheme: "bearer", description: "Opaque token returned by POST /api/activity/session" } } },
    paths,
  };
}
