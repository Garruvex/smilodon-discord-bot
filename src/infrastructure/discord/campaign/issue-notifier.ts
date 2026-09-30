import type { CampaignIssue, CampaignRecord } from "../../../application/campaign/ports/campaign-record.js";
import { texts } from "../../../application/i18n/texts.js";
import type { CampaignMessageGateway } from "./campaign-message-gateway.js";

// Tells the organizer, once, that something needs them (an issue's first
// appearance). It goes to the first place the bot can still write: the Party
// post, then the Games post. When neither works it throws, so the issue stays
// unnotified and is told again when it next comes up; it always shows in Manage.
export function organizerNotice(messages: CampaignMessageGateway): (record: CampaignRecord, issue: CampaignIssue) => Promise<void> {
  return async (record, issue): Promise<void> => {
    const t = texts[record.language].campaign.issue.notice;
    const content = t[issue.code]({ organizer: `<@${record.organizerId}>`, detail: issue.detail });
    const places = [record.channels.partyPostId, record.channels.adventurePostId].filter((id): id is string => id !== null);
    let lastError: unknown = new Error("The game has no channel to write in.");
    for (const channelId of places) {
      try {
        await messages.post(channelId, content, [record.organizerId]);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };
}
