import { RevisionConflictError, type CampaignKey, type CampaignUnitOfWork } from "./ports/campaign-store.js";
import type { CampaignIssue, CampaignIssueCode, CampaignRecord } from "./ports/campaign-record.js";
import type { Clock } from "./ports/clock.js";

export interface CampaignIssuesOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly clock: Clock;
  // Tells the organizer about an issue the first time it appears. A failure
  // here is swallowed: the issue stays on the record and shows in Manage.
  readonly notify?: (record: CampaignRecord, issue: CampaignIssue) => Promise<void>;
}

// What is wrong with a game that the organizer has to fix (plan §10: report the
// issue and let the organizer repair it instead of failing again and again).
// One entry per kind: raising it again only refreshes the detail, so a
// problem that keeps happening is one line in Manage and one notice, not a
// flood. Finished games record nothing.
export class CampaignIssues {
  public constructor(private readonly options: CampaignIssuesOptions) {}

  public async raise(key: CampaignKey, code: CampaignIssueCode, detail: string): Promise<void> {
    let fresh: { record: CampaignRecord; issue: CampaignIssue } | null = null;
    await this.change(key, (record) => {
      if (record.lifecycle === "archived") return record;
      const issues = record.issues ?? [];
      const existing = issues.find((issue) => issue.code === code);
      if (existing !== undefined) {
        const next = existing.detail === detail ? record : { ...record, issues: issues.map((issue) => (issue.code === code ? { ...issue, detail } : issue)) };
        // Nobody has been told yet (the channel was unreachable): try again.
        if (!existing.notified) fresh = { record: next, issue: { ...existing, detail } };
        return next;
      }
      const issue: CampaignIssue = { code, detail, since: this.options.clock.now(), notified: false };
      const next = { ...record, issues: [...issues, issue] };
      fresh = { record: next, issue };
      return next;
    });
    if (fresh === null) return;
    const { record, issue } = fresh as { record: CampaignRecord; issue: CampaignIssue };
    try {
      await this.options.notify?.(record, issue);
    } catch {
      return;
    }
    await this.change(key, (latest) => ({ ...latest, issues: (latest.issues ?? []).map((entry) => (entry.code === code ? { ...entry, notified: true } : entry)) }));
  }

  public async clear(key: CampaignKey, codes: readonly CampaignIssueCode[]): Promise<void> {
    await this.change(key, (record) => {
      const issues = record.issues ?? [];
      if (!issues.some((issue) => codes.includes(issue.code))) return record;
      return { ...record, issues: issues.filter((issue) => !codes.includes(issue.code)) };
    });
  }

  private async change(key: CampaignKey, apply: (record: CampaignRecord) => CampaignRecord): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.options.unitOfWork.transaction(async (tx) => {
          const stored = await tx.loadRecord(key);
          if (stored === undefined) return;
          const next = apply(stored.record);
          if (next !== stored.record) await tx.saveRecord(next, stored.revision);
        });
        return;
      } catch (error) {
        if (!(error instanceof RevisionConflictError)) throw error;
      }
    }
  }
}
