import { Events, type Client } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { Application } from "../../src/bootstrap/application.js";
import type { ApplicationDependencies } from "../../src/bootstrap/dependencies.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";

type Handler = (...args: never[]) => void;

function createFakeClient(): { client: Client; emit: (event: string, ...args: unknown[]) => Promise<void> } {
  const handlers = new Map<string, Handler[]>();
  const client = {
    once: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    user: { id: "bot-id" },
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as Client;
  return {
    client,
    emit: async (event: string, ...args: unknown[]): Promise<void> => {
      for (const handler of handlers.get(event) ?? []) (handler as (...a: unknown[]) => void)(...args);
      // Flush the microtask queue so fire-and-forget async handlers settle.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function fakeCommandInteraction(reply: ReturnType<typeof vi.fn>): {
  isButton: () => boolean; isStringSelectMenu: () => boolean;
  isChatInputCommand: () => boolean; isMessageContextMenuCommand: () => boolean;
  isRepliable: () => boolean; reply: typeof reply;
} {
  return {
    isButton: () => false, isStringSelectMenu: () => false,
    isChatInputCommand: () => true, isMessageContextMenuCommand: () => false,
    isRepliable: () => true, reply,
  };
}

function fakeMessage(channelId: string, reply: ReturnType<typeof vi.fn>): {
  inGuild: () => boolean; author: { bot: boolean }; webhookId: null;
  guildId: string; channelId: string; reply: typeof reply;
} {
  return {
    inGuild: () => true, author: { bot: false }, webhookId: null,
    guildId: "guild", channelId, reply,
  };
}

function fakeReadyClient(): unknown {
  const cache = Object.assign([] as unknown[], { size: 0 });
  return { user: { id: "bot-id", username: "Bot" }, guilds: { cache } };
}

function stubProvider(): GuildConfigurationProvider {
  const profile = {
    guildId: "guild",
    features: { music: true, chatbot: false },
    channels: { controlPanel: "control-channel" },
  } as unknown as GuildConfiguration;
  return {
    initialize: () => Promise.resolve(),
    find: () => profile,
    require: () => profile,
    getAll: () => [profile],
    create: () => Promise.reject(new Error("not used")),
    update: () => Promise.reject(new Error("not used")),
    reload: () => Promise.resolve(),
  };
}

function stubLogger(): Logger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function buildApplication(options: {
  musicInitResult: "resolve" | "reject";
  controlChannelInitResult: "resolve" | "reject";
}): {
  application: Application;
  client: Client;
  emit: (event: string, ...args: unknown[]) => Promise<void>;
  handleMessage: ReturnType<typeof vi.fn>;
  commandDispatch: ReturnType<typeof vi.fn>;
  behaviorDispatch: ReturnType<typeof vi.fn>;
  backgroundStarts: readonly ReturnType<typeof vi.fn>[];
} {
  const { client, emit } = createFakeClient();
  const handleMessage = vi.fn().mockResolvedValue(false);
  const commandDispatch = vi.fn().mockResolvedValue(undefined);
  const behaviorDispatch = vi.fn().mockResolvedValue(undefined);

  const controlChannelService = {
    initialize: () => options.controlChannelInitResult === "resolve"
      ? Promise.resolve()
      : Promise.reject(new Error("control-channel init failed")),
    handleButton: vi.fn().mockResolvedValue(false),
    handleMessage,
    stop: vi.fn(),
    handleGuildRemoved: vi.fn(),
  } as unknown as ConstructorParameters<typeof Application>[3];

  const musicPresenceStart = vi.fn();
  const birthdayStart = vi.fn();
  const channelSummaryStart = vi.fn();
  const reminderStart = vi.fn();
  const musicPresenceService = { start: musicPresenceStart, stop: vi.fn() } as unknown as ConstructorParameters<typeof Application>[4];
  const birthdayAnnouncer = { start: birthdayStart, stop: vi.fn() } as unknown as ConstructorParameters<typeof Application>[5];
  const memberDepartureService = { handleMemberLeave: vi.fn().mockResolvedValue(undefined) } as unknown as ConstructorParameters<typeof Application>[6];
  const memberWelcomeService = {
    handleMemberJoin: vi.fn().mockResolvedValue(undefined),
    handleMemberLeave: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConstructorParameters<typeof Application>[7];

  const dependencies = {
    guildConfigurationProvider: stubProvider(),
    musicPlayerGateway: {
      initialize: () => options.musicInitResult === "resolve" ? Promise.resolve() : Promise.reject(new Error("lavalink init failed")),
      acceptDiscordGatewayPayload: vi.fn(),
      hasPlayer: vi.fn().mockReturnValue(false),
      getVoiceChannelId: vi.fn().mockReturnValue(null),
    },
    applicationEmojiCatalog: { initialize: () => Promise.resolve() },
    componentDispatcher: { dispatch: vi.fn().mockResolvedValue(undefined) },
    commandDispatcher: { dispatch: commandDispatch },
    behaviorDispatcher: { dispatch: behaviorDispatch },
    channelSummaryScheduler: { start: channelSummaryStart, stop: vi.fn() },
    reminderScheduler: { start: reminderStart, stop: vi.fn() },
    pollService: { stop: vi.fn() },
  } as unknown as ApplicationDependencies;

  const application = new Application(
    client,
    {} as ApplicationConfiguration,
    dependencies,
    controlChannelService,
    musicPresenceService,
    birthdayAnnouncer,
    memberDepartureService,
    memberWelcomeService,
    stubLogger(),
  );

  return {
    application, client, emit, handleMessage, commandDispatch, behaviorDispatch,
    backgroundStarts: [musicPresenceStart, birthdayStart, channelSummaryStart, reminderStart],
  };
}

describe("Application readiness gating", () => {
  it("never becomes ready when Lavalink initialization fails", async () => {
    const { emit, commandDispatch, backgroundStarts } = buildApplication({ musicInitResult: "reject", controlChannelInitResult: "resolve" });
    await emit(Events.ClientReady, fakeReadyClient());

    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = fakeCommandInteraction(reply);
    await emit(Events.InteractionCreate, interaction);

    expect(commandDispatch).not.toHaveBeenCalled();
    for (const start of backgroundStarts) expect(start).not.toHaveBeenCalled();
    const replyPayload = reply.mock.calls[0]?.[0] as { content?: string } | undefined;
    expect(replyPayload?.content).toContain("starting up");
  });

  it("becomes ready when Lavalink succeeds even if the control panel fails (degraded, not fatal)", async () => {
    const { emit, commandDispatch, backgroundStarts } = buildApplication({ musicInitResult: "resolve", controlChannelInitResult: "reject" });
    await emit(Events.ClientReady, fakeReadyClient());

    const interaction = fakeCommandInteraction(vi.fn().mockResolvedValue(undefined));
    await emit(Events.InteractionCreate, interaction);

    expect(commandDispatch).toHaveBeenCalledWith(interaction);
    for (const start of backgroundStarts) expect(start).toHaveBeenCalledOnce();
  });

  it("replies to a control-channel message sent before startup finishes, instead of dispatching it", async () => {
    const { emit, handleMessage, behaviorDispatch } = buildApplication({ musicInitResult: "reject", controlChannelInitResult: "resolve" });
    // Deliberately do NOT await ClientReady settling — a message can arrive
    // in the same tick the gateway connects, before init resolves.

    const reply = vi.fn().mockResolvedValue(undefined);
    const message = fakeMessage("control-channel", reply);
    await emit(Events.MessageCreate, message);

    expect(reply).toHaveBeenCalledWith(expect.stringContaining("starting up"));
    expect(handleMessage).not.toHaveBeenCalled();
    expect(behaviorDispatch).not.toHaveBeenCalled();
  });

  it("silently drops a non-control-channel message sent before startup finishes", async () => {
    const { emit, handleMessage, behaviorDispatch } = buildApplication({ musicInitResult: "reject", controlChannelInitResult: "resolve" });

    const reply = vi.fn().mockResolvedValue(undefined);
    const message = fakeMessage("some-other-channel", reply);
    await emit(Events.MessageCreate, message);

    expect(reply).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(behaviorDispatch).not.toHaveBeenCalled();
  });

  it("dispatches messages normally once ready", async () => {
    const { emit, handleMessage } = buildApplication({ musicInitResult: "resolve", controlChannelInitResult: "resolve" });
    await emit(Events.ClientReady, fakeReadyClient());

    const message = fakeMessage("control-channel", vi.fn().mockResolvedValue(undefined));
    await emit(Events.MessageCreate, message);

    expect(handleMessage).toHaveBeenCalledWith(message);
  });
});
