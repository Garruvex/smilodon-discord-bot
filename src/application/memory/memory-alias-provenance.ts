import { hashContent } from "../assets/content-hash.js";
import { parseContextProvenance, type ContextProvenance } from "../chat/context-provenance.js";
import type { Memory } from "./memory.js";

export type AliasScope = Pick<Memory, "guildId" | "audience" | "ownerUserId" | "channelId" | "isolationChannelId" | "subjectType" | "subjectId">;
export function memoryAliasPayload(scope: AliasScope, value: string): string {
  return JSON.stringify({ guildId: scope.guildId, audience: scope.audience, ownerUserId: scope.ownerUserId, channelId: scope.channelId,
    isolationChannelId: scope.isolationChannelId, subjectType: scope.subjectType, subjectId: scope.subjectId, value: value.toLowerCase() });
}
export function memoryAliasProof(value: unknown, scope: AliasScope, name: string): ContextProvenance | null {
  const proof = parseContextProvenance(value);
  return proof?.purpose === "identity_alias" && proof.coverage === "complete" && proof.outputHash === hashContent(memoryAliasPayload(scope, name)) ? proof : null;
}
export function explicitSelfAlias(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (new RegExp(`(?:(?:don't|do not|never)\\s+call me|(?:別|别|不要|不准)叫我)[\\s「"']*${escaped}(?=$|[\\s.,，。！？!?;；:："」])`, "iu").test(text)) return false;
  return new RegExp(`(?:\\bcall me|\\bmy (?:name|nickname) is|我叫|叫我|我的(?:名字|暱稱)是|名前は)[\\s「"']*${escaped}(?=$|[\\s.,，。！？!?;；:："」])|(?:^|[\\s「"']|私を)${escaped}と呼んで`, "iu").test(text);
}
