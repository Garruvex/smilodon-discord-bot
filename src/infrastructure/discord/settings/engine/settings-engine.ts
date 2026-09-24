import type { AttachmentBuilder } from "discord.js";

import type { ChatToolRegistry } from "../../../../application/chat/tools/chat-tool-registry.js";
import { settingsText, type SettingsText } from "../../../../application/i18n/settings/index.js";
import { texts } from "../../../../application/i18n/texts.js";
import type { SettingsUpdateService } from "../../../../application/settings/settings-update-service.js";
import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import { RoleMatchMode, publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import { registeredNodes, type RegisteredNode } from "../registry/paths.js";
import type { NodeContext, Patch, SettingsGroup } from "../registry/types.js";
import { assertValidRegistry } from "../registry/validate-registry.js";
import { describeSettingChange } from "./describe-change.js";
import type { AdminPanelRepair, SettingDeps, SettingRequest } from "./request.js";
import { buildSettingPatch } from "./setting-patch.js";

// Who may change settings through /settings-* and the admin panel. (Guided
// setup is gated like /setup instead — see its component handler.)
export const settingsAccessPolicy = {
  ...publicAccessPolicy,
  roles: { match: RoleMatchMode.Any, requiredGroups: ["botAdministrator" as const] },
};

// Which surface a change came from — only used to label the audit entry.
export type SettingSource =
  | { kind: "slash"; command: string }
  | { kind: "panel" }
  | { kind: "setup" };

export type SettingRunResult =
  | { kind: "report"; text: string }
  | { kind: "rejected"; message: string }
  // The values asked for no change; nothing was written.
  | { kind: "empty" }
  | { kind: "updated"; description: string; previous: GuildConfiguration; updated: GuildConfiguration }
  | { kind: "done"; message: string; files: readonly AttachmentBuilder[] };

export interface SettingsEngineOptions {
  registry: readonly SettingsGroup[];
  profiles: GuildConfigurationProvider;
  updater: SettingsUpdateService;
  deps: SettingDeps;
}

// The one place a registered setting runs. Every surface — the /settings-*
// commands, the admin panel, guided setup — turns its interaction into a
// SettingRequest and calls run(); validation, the write, the confirmation,
// the audit entry and every follow-up effect come from here, so surfaces
// can't disagree about what a change does.
export class SettingsEngine {
  private readonly nodes: ReadonlyMap<string, RegisteredNode>;
  private readonly deps: SettingDeps;

  public constructor(private readonly options: SettingsEngineOptions) {
    assertValidRegistry(options.registry);
    this.nodes = new Map(registeredNodes(options.registry).map((node) => [node.path, node]));
    this.deps = { ...options.deps };
  }

  public get registry(): readonly SettingsGroup[] {
    return this.options.registry;
  }

  public find(path: string): RegisteredNode | undefined {
    return this.nodes.get(path);
  }

  public registered(): readonly RegisteredNode[] {
    return [...this.nodes.values()];
  }

  // Bound once dependencies.ts has derived the registry from every
  // registered command's toolBinding (see SettingDeps.chatToolRegistry).
  public bindChatToolRegistry(chatToolRegistry: ChatToolRegistry): void {
    this.deps.chatToolRegistry = chatToolRegistry;
  }

  public bindAdminPanel(adminPanel: AdminPanelRepair): void {
    this.deps.adminPanel = adminPanel;
  }

  public async run(registered: RegisteredNode, request: SettingRequest, source: SettingSource): Promise<SettingRunResult> {
    const profile = this.options.profiles.require(request.guildId);
    const text = settingsText(request.language);
    const context: NodeContext = { request, deps: this.deps, profile, text, path: registered.path };
    const { node } = registered;

    switch (node.kind) {
      case "report":
        return { kind: "report", text: await node.render({ ...context, values: request.values }) };

      case "action": {
        const result = await node.run({ ...context, values: request.values });
        if (!result.ok) return { kind: "rejected", message: result.message };
        if (result.patch) {
          const saved = await this.save(registered, request, source, result.patch, () => result.message);
          if (saved.kind !== "updated") return saved;
        } else {
          await this.deps.auditLogService?.log(request.guildId, request.actorUserId, `${this.heading(registered, source, text)}\n${result.message}`);
        }
        return { kind: "done", message: result.message, files: result.files ?? [] };
      }

      case "setting": {
        const patch = await buildSettingPatch(node, request.values, {
          path: registered.path,
          guildId: request.guildId,
          guild: request.guild,
          profile,
          deps: this.deps,
          text,
          ui: texts[request.language].settings,
        });
        if (patch.kind !== "patch") return patch;
        return this.save(registered, request, source, patch.patch, (previous, updated) =>
          describeSettingChange(node, registered.path, previous, updated, text, texts[request.language].settings, this.deps, patch.notes));
      }
    }
  }

  private async save(
    registered: RegisteredNode,
    request: SettingRequest,
    source: SettingSource,
    patch: Patch,
    describe: (previous: GuildConfiguration, updated: GuildConfiguration) => string,
  ): Promise<SettingRunResult> {
    const text = settingsText(request.language);
    try {
      const applied = await this.options.updater.apply({
        guildId: request.guildId,
        actorUserId: request.actorUserId,
        auditHeading: this.heading(registered, source, text),
        input: patch,
        describe,
      });
      return { kind: "updated", description: applied.description, previous: applied.previous, updated: applied.updated };
    } catch (error) {
      // The config's own schema has the last word (e.g. a default volume
      // above the maximum); refuse with its reason rather than failing.
      return {
        kind: "rejected",
        message: texts[request.language].settings.error.saveFailed({ reason: failureReason(error) }),
      };
    }
  }

  private heading(registered: RegisteredNode, source: SettingSource, text: SettingsText): string {
    const setting = `${text.title(registered.group.name)} › ${text.label(registered.path)}`;
    const audit = texts[text.language].settings.audit;
    switch (source.kind) {
      case "slash":
        return `**/${source.command}**`;
      case "panel":
        return `**${audit.panel({ setting })}**`;
      case "setup":
        return `**${audit.setup({ setting })}**`;
    }
  }
}

function failureReason(error: unknown): string {
  const issues = (error as { issues?: readonly { message?: string }[] } | null)?.issues;
  if (issues !== undefined && issues.length > 0) return issues.map((issue) => issue.message ?? "").join("; ");
  return error instanceof Error ? error.message : String(error);
}
