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
  policy: SocialChatEligibility; members: Map<string, GuildMember>; fetchMember: ReturnType<typeof vi.fn>;
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
  const guild = { id: profile.guildId, members: { fetch: fetchMember } };
  const channel = { messages: { cache: new Map(), fetch: vi.fn((input: { message?: string; before?: string }) => {
    if (input.message) return Promise.resolve(messages.get(input.message) ?? null);
    const before = input.before ? messages.get(input.before)?.createdTimestamp ?? Infinity : Infinity;
    return Promise.resolve(new Map([...messages].filter(([, message]) => message.createdTimestamp < before).reverse()));
  }) } };
  const message = (id: string, authorId: string, createdTimestamp: number, content: string): Message => {
    const user = { id: authorId, username: authorId, displayName: authorId, globalName: null, bot: false } as User;
    const member = { user, id: authorId, displayName: authorId, nickname: null, guild, roles: { cache: new Map([["chat-role", { id: "chat-role", name: "Chat" }]]) } } as unknown as GuildMember;
    members.set(authorId, member);
    const result = { id, guildId: profile.guildId, channelId: "channel", guild, channel, author: user, member: warm ? member : null,
      createdTimestamp, content, inGuild: () => true, client: { user: { id: "bot" } }, attachments: new Map(), mentions: { users: new Map() } } as unknown as Message;
    messages.set(id, result); return result;
  };
  const old = message("old", "bob", 1000, "SECRET_OLD_SOURCE"); const current = message("current", "alice", 10_000_000, "@bot");
  const { logger, records } = captureDiagnosticLogger(); const support = new ChatTurnSupport(logger, policy, origins);
  return { support, policy, current, old, repository, members, fetchMember, records };
}

describe("Discord context guard", () => {
  it.each([false, true])("resolves current membership equally with warm message cache=%s", async (warm) => {
    const { support, current, fetchMember } = fixture(warm);
    const context = await GuardedConversationContext.open(support.createContextPort(current), { count: 40, budget: 12000, burstIds: [] });
    expect(context.history.map((event) => event.messageId)).toEqual(["old"]);
    expect(fetchMember).toHaveBeenCalledWith({ user: "bob", force: true });
    expect(fetchMember).toHaveBeenCalledWith({ user: "alice", force: true });
  });
  it("honors persistent forgetting on revalidation and on a newly created lease", async () => {
    const { support, current, repository, old, records } = fixture(false);
    const context = await GuardedConversationContext.open(support.createContextPort(current), { count: 40, budget: 12000, burstIds: [] });
    await repository.recordForgetCutoff({ guildId: old.guildId!, subjectId: old.author.id, topic: "*", slot: "*", scopeKey: "*", cutoff: 2000 });
    expect(await context.validate()).toBe(false);
    const later = await GuardedConversationContext.open(support.createContextPort(current), { count: 40, budget: 12000, burstIds: [] });
    expect(later.history).toEqual([]);
    expect(JSON.stringify(records)).not.toContain("SECRET");
    expect(records.some((record) => record.reason === "source_forgotten")).toBe(true);
  });
  it("rechecks roles rather than relying on the role cache from collection", async () => {
    const { support, current, members } = fixture(true);
    const context = await GuardedConversationContext.open(support.createContextPort(current), { count: 40, budget: 12000, burstIds: [] });
    members.get("bob")!.roles.cache.clear();
    expect(await context.validate()).toBe(false);
  });
});
