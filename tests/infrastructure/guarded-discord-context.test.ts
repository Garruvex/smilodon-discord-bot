import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuildMember, Message, User } from "discord.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import { SocialChatEligibility } from "../../src/infrastructure/discord/behaviors/social-chat-eligibility.js";
import { ChatTurnSupport } from "../../src/infrastructure/discord/behaviors/chat-turn-support.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { SqliteMessageOriginStore } from "../../src/infrastructure/persistence/sqlite-message-origin-store.js";
import { freshProfile } from "../helpers/settings-fixtures.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";

const close: (() => void)[] = [];
afterEach(() => close.splice(0).forEach((cleanup) => cleanup()));
function fixture(warm: boolean): {
  support: ChatTurnSupport; current: Message; old: Message; repository: SqliteMemoryRepository;
  messages: Map<string, Message>; origins: SqliteMessageOriginStore; client: EventEmitter; profile: ReturnType<typeof freshProfile>; policy: SocialChatEligibility; members: Map<string, GuildMember>; fetchMember: ReturnType<typeof vi.fn>;
  records: ReturnType<typeof captureDiagnosticLogger>["records"];
} {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "guarded-discord-"))); close.push(() => connection.close());
  const repository = new SqliteMemoryRepository(connection.database); const origins = new SqliteMessageOriginStore(connection.database);
  const profile = freshProfile(); profile.features.chatbot = true; profile.features.channelHistory = true; profile.channels.chatbot = new Set(["channel"]); profile.roles.chatbot = new Set(["chat-role"]);
  const policy = new SocialChatEligibility({ ownerUserIds: new Set() } as unknown as ApplicationConfiguration,
    { find: () => profile } as unknown as GuildConfigurationProvider, origins, null);
  policy.bindGuardedForgetPolicy((message) => repository.isSourceForgotten({ guildId: profile.guildId, subjectId: message.author.id,
    topic: "*", slot: `source:${message.id}`, channelId: message.channelId, sourceTimestampMs: message.createdTimestamp }));
  const members = new Map<string, GuildMember>(); const messages = new Map<string, Message>();
  const fetchMember = vi.fn((input: { user: string }) => Promise.resolve(members.get(input.user) ?? null));
  const client = Object.assign(new EventEmitter(), { user: { id: "bot" }, isReady: (): boolean => true });
  const guild = { id: profile.guildId, members: { me: {} as GuildMember, cache: members, fetch: fetchMember } };
  const channel = { permissionsFor: (): { has: () => boolean } => ({ has: (): boolean => true }), messages: { cache: new Map(), fetch: vi.fn((input: { message?: string; before?: string }) => {
    if (input.message) return Promise.resolve(messages.get(input.message) ?? null);
    const before = input.before ? messages.get(input.before)?.createdTimestamp ?? Infinity : Infinity;
    return Promise.resolve(new Map([...messages].filter(([, message]) => message.createdTimestamp < before).reverse()));
  }) } };
  const message = (id: string, authorId: string, createdTimestamp: number, content: string): Message => {
    const user = { id: authorId, username: authorId, displayName: authorId, globalName: null, bot: false } as User;
    const member = { user, id: authorId, displayName: authorId, nickname: null, guild, roles: { cache: new Map([["chat-role", { id: "chat-role", name: "Chat" }]]) } } as unknown as GuildMember;
    members.set(authorId, member);
    const result = { id, guildId: profile.guildId, channelId: "channel", guild, channel, author: user, member: warm ? member : null,
      createdTimestamp, content, inGuild: () => true, client, attachments: new Map(), mentions: { users: new Map() } } as unknown as Message;
    messages.set(id, result); return result;
  };
  const old = message("old", "bob", 1000, "SECRET_OLD_SOURCE"); const current = message("current", "alice", 10_000_000, "@bot");
  const { logger, records } = captureDiagnosticLogger(); const support = new ChatTurnSupport(logger, policy, origins);
  return { support, policy, current, old, repository, members, fetchMember, records, client, profile, messages, origins };
}

describe("Discord context guard", () => {
  it("resolves uncached exclusion-role membership once per author and shares it across phases", async () => {
    const { support, current, profile, fetchMember } = fixture(false);
    profile.chat.contextOptOutRoleIds = ["private-role"];
    Object.assign(current.guild!.members, { cache: new Map() });
    const context = await GuardedConversationContext.open(support.createContextPort(current), { count: 40, budget: 12000, burstIds: [] });
    expect(fetchMember).toHaveBeenCalledTimes(2);
    await context.participants(["bob"]); await context.images(2); await context.sessions([]);
    for (let index = 0; index < 20; index++) expect(await context.validate()).toBe(true);
    expect(fetchMember).toHaveBeenCalledTimes(2);
  });
  it.each(["user", "role"] as const)("excludes %s opt-outs from both literal messages and derived bot context", async (kind) => {
    const { support, current, old, profile, members, messages, origins } = fixture(true);
    const prior = await GuardedConversationContext.open(support.createContextPort(current), { count: 40, budget: 12000, burstIds: [] });
    const bot = { ...old, id: "derived", content: "DERIVED_SECRET", createdTimestamp: 2000, author: { ...old.author, id: "bot", bot: true }, reference: null } as Message;
    messages.set(bot.id, bot);
    await origins.record({ guildId: profile.guildId, channelId: "channel", messageId: bot.id, origin: "chat", sourceMessageId: current.id,
      contextProvenance: prior.provenance(bot.content), createdAt: bot.createdTimestamp });
    if (kind === "user") profile.chat.contextOptOutUserIds = ["bob"];
    else { profile.chat.contextOptOutRoleIds = ["private-role"]; members.get("bob")!.roles.cache.set("private-role", { id: "private-role", name: "Private" } as never); }
    const next = await GuardedConversationContext.open(support.createContextPort(current), { count: 40, budget: 12000, burstIds: [] });
    expect(JSON.stringify(next.history)).not.toContain("SECRET");
    expect(next.history.map((event) => event.messageId)).not.toContain("old");
    expect(next.history.map((event) => event.messageId)).not.toContain("derived");
  });
  it.each([false, true])("uses cached channel membership without REST lookups when role exclusions are absent, warm message cache=%s", async (warm) => {
    const { support, current, fetchMember } = fixture(warm);
    const context = await GuardedConversationContext.open(support.createContextPort(current), { count: 40, budget: 12000, burstIds: [] });
    expect(context.history.map((event) => event.messageId)).toEqual(["old"]);
    expect(fetchMember).not.toHaveBeenCalled();
  });
  it("honors persistent forgetting on revalidation and on a newly created lease", async () => {
    const { support, current, repository, old, records } = fixture(false);
    const context = await GuardedConversationContext.open(support.createContextPort(current), { count: 40, budget: 12000, burstIds: [] });
    await repository.recordForgetCutoff({ guildId: old.guildId!, subjectId: old.author.id, topic: "*", slot: "*", scopeKey: "*", cutoff: 2000 });
    expect(await context.validate("effect")).toBe(false);
    const later = await GuardedConversationContext.open(support.createContextPort(current), { count: 40, budget: 12000, burstIds: [] });
    expect(later.history).toEqual([]);
    expect(JSON.stringify(records)).not.toContain("SECRET");
    expect(records.some((record) => record.reason === "source_forgotten")).toBe(true);
  });
  it("invalidates collected context when a member gains an explicit opt-out role", async () => {
    const { support, current, members, profile, client } = fixture(true);
    profile.chat.contextOptOutRoleIds = ["private-role"];
    const context = await GuardedConversationContext.open(support.createContextPort(current), { count: 40, budget: 12000, burstIds: [] });
    members.get("bob")!.roles.cache.set("private-role", { id: "private-role", name: "private-role" } as never);
    client.emit("guildMemberUpdate", {}, { guild: { id: profile.guildId } });
    expect(await context.validate()).toBe(false);
  });
});
