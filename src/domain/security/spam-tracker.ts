// Spotting the signature of a hacked account: the same message, posted across
// several channels in quick succession. Pure and in memory — a restart
// forgetting the last minute of traffic costs nothing.

export interface TrackedPost {
  channelId: string;
  messageId: string;
  at: number;
}

export interface SpamAttachment {
  name: string;
  size: number;
}

const minPlainLength = 8;
const linkMatches = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

// The links in a message, normalized so spelling variations of one address
// compare equal. A scam pasted into many channels is usually reworded around
// the same link, so the link is a steadier mark than the text around it.
function normalizedLinks(content: string): string[] {
  const links = new Set<string>();
  for (const match of content.toLowerCase().matchAll(linkMatches)) {
    links.add(match[0].replace(/[.,;:!?)\]>]+$/, "").replace(/^(?:https?:\/\/)?(?:www\.)?/, ""));
  }
  return [...links].sort();
}

// What two posts must share to count as "the same message", or null when a
// post is too small to say anything (a "lol" in three channels is not spam).
export function spamFingerprint(content: string, attachments: readonly SpamAttachment[]): string | null {
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  const links = normalizedLinks(content);
  if (links.length > 0) return `links:${links.join("|")}`;
  if (normalized.length >= minPlainLength) return `text:${normalized}`;
  if (attachments.length > 0) {
    return `files:${attachments.map((file) => `${file.name.toLowerCase()}:${file.size}`).sort().join("|")}`;
  }
  return null;
}

export interface SpamVerdict {
  triggered: boolean;
  // Every post of the repeated message still inside the window, to remove.
  posts: readonly TrackedPost[];
  channels: number;
}

const notSpam: SpamVerdict = { triggered: false, posts: [], channels: 0 };

// Bounds memory: the busiest guilds still only hold what the window needs.
const maxPostsPerMember = 50;
const maxTrackedMembers = 20_000;

export class SpamTracker {
  private readonly members = new Map<string, Map<string, TrackedPost[]>>();

  // Records a post and says whether it completes a spam pattern. A triggered
  // verdict clears that message, so the same burst isn't reported twice.
  public record(
    memberKey: string,
    fingerprint: string,
    post: TrackedPost,
    windowMs: number,
    channelThreshold: number,
  ): SpamVerdict {
    const byMessage = this.members.get(memberKey) ?? new Map<string, TrackedPost[]>();
    const cutoff = post.at - windowMs;
    let total = 0;
    for (const [key, posts] of byMessage) {
      const recent = posts.filter((entry) => entry.at >= cutoff);
      if (recent.length === 0) byMessage.delete(key);
      else {
        byMessage.set(key, recent);
        total += recent.length;
      }
    }

    const posts = [...(byMessage.get(fingerprint) ?? []), post];
    // A member posting without end can't grow the map without bound.
    if (total < maxPostsPerMember) byMessage.set(fingerprint, posts);

    const channels = new Set(posts.map((entry) => entry.channelId)).size;
    if (channels >= channelThreshold) {
      byMessage.delete(fingerprint);
      if (byMessage.size === 0) this.members.delete(memberKey);
      return { triggered: true, posts, channels };
    }

    if (byMessage.size > 0) {
      this.members.set(memberKey, byMessage);
      if (this.members.size > maxTrackedMembers) this.forgetOldest();
    }
    return notSpam;
  }

  public forget(memberKey: string): void {
    this.members.delete(memberKey);
  }

  private forgetOldest(): void {
    const oldest = this.members.keys().next().value;
    if (oldest !== undefined) this.members.delete(oldest);
  }
}
