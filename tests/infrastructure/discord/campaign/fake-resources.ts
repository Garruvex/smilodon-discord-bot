import type {
  CampaignResourceGateway,
  ForumOptions,
  ForumPost,
  ForumPostOptions,
  TextChannelOptions,
} from "../../../../src/infrastructure/discord/campaign/campaign-resource-gateway.js";
import { withMarker } from "../../../../src/infrastructure/discord/campaign/campaign-resource-gateway.js";

export interface FakeChannel {
  id: string;
  options: TextChannelOptions;
}

export interface FakeForum {
  id: string;
  options: ForumOptions;
}

export interface FakeForumPost {
  id: string;
  forumId: string;
  name: string;
  content: string;
  tag: string | null;
  archived: boolean;
  locked: boolean;
}

export class FakeResources implements CampaignResourceGateway {
  public readonly categories = new Set<string>();
  public readonly channels: FakeChannel[] = [];
  public readonly threads: { id: string; channelId: string; name: string }[] = [];
  public readonly roles = new Set<string>();
  public missing: string[] = [];
  public failCreates = 0;
  public failThreads = 0;
  private next = 0;

  public createCategory(): Promise<string> {
    this.next += 1;
    const id = `cat${this.next}`;
    this.categories.add(id);
    return Promise.resolve(id);
  }

  public categoryExists(_guildId: string, categoryId: string): Promise<boolean> {
    return Promise.resolve(this.categories.has(categoryId));
  }

  public createTextChannel(_guildId: string, options: TextChannelOptions): Promise<string> {
    if (this.failCreates > 0) {
      this.failCreates -= 1;
      // The create may have gone through even though the bot never heard back.
      this.next += 1;
      this.channels.push({ id: `ch${this.next}`, options });
      return Promise.reject(new Error("timeout"));
    }
    this.next += 1;
    const id = `ch${this.next}`;
    this.channels.push({ id, options });
    return Promise.resolve(id);
  }

  public channelExists(_guildId: string, channelId: string): Promise<boolean> {
    return Promise.resolve(this.channels.some((channel) => channel.id === channelId));
  }

  public findTextChannelByMarker(_guildId: string, _categoryId: string | null, marker: string): Promise<string | null> {
    return Promise.resolve(this.channels.find((channel) => channel.options.topic.includes(marker))?.id ?? null);
  }

  public channelNames(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(this.channels.map((channel) => channel.options.name)));
  }

  public createDiscussionThread(channelId: string, name: string): Promise<string> {
    if (this.failThreads > 0) {
      this.failThreads -= 1;
      return Promise.reject(new Error("no thread permission"));
    }
    this.next += 1;
    const id = `th${this.next}`;
    this.threads.push({ id, channelId, name });
    return Promise.resolve(id);
  }

  public findThreadByName(channelId: string, name: string): Promise<string | null> {
    return Promise.resolve(this.threads.find((thread) => thread.channelId === channelId && thread.name === name)?.id ?? null);
  }

  public threadExists(threadId: string): Promise<boolean> {
    return Promise.resolve(this.threads.some((thread) => thread.id === threadId));
  }

  public readonly roleNames: string[] = [];

  public createRole(_guildId?: string, name?: string): Promise<string> {
    this.next += 1;
    const id = `role${this.next}`;
    this.roles.add(id);
    if (name !== undefined) this.roleNames.push(name);
    return Promise.resolve(id);
  }

  public roleExists(_guildId: string, roleId: string): Promise<boolean> {
    return Promise.resolve(this.roles.has(roleId));
  }

  public readonly grants: { roleId: string; userId: string }[] = [];
  public readonly restricted: { channelId: string; roleId: string; allowThreadMessages: boolean }[] = [];
  public failGrants = false;

  public grantRole(_guildId: string, roleId: string, userId: string): Promise<void> {
    if (this.failGrants) return Promise.reject(new Error("Missing Permissions"));
    if (!this.grants.some((grant) => grant.roleId === roleId && grant.userId === userId)) this.grants.push({ roleId, userId });
    return Promise.resolve();
  }

  public restrictToRole(_guildId: string, channelId: string, roleId: string, allowThreadMessages: boolean): Promise<void> {
    if (this.failGrants) return Promise.reject(new Error("Missing Permissions"));
    this.restricted.push({ channelId, roleId, allowThreadMessages });
    return Promise.resolve();
  }

  public missingPermissions(): Promise<readonly string[]> {
    return Promise.resolve(this.missing);
  }

  public readonly forums: FakeForum[] = [];
  public readonly forumPosts: FakeForumPost[] = [];

  public createForum(_guildId: string, options: ForumOptions): Promise<string> {
    this.next += 1;
    const id = `forum${this.next}`;
    this.forums.push({ id, options });
    return Promise.resolve(id);
  }

  public forumExists(_guildId: string, forumId: string): Promise<boolean> {
    return Promise.resolve(this.forums.some((forum) => forum.id === forumId));
  }

  public createForumPost(options: ForumPostOptions): Promise<ForumPost> {
    this.next += 1;
    const id = `post${this.next}`;
    this.forumPosts.push({ id, forumId: options.forumId, name: options.name, content: withMarker(options.content, options.marker), tag: null, archived: false, locked: false });
    return Promise.resolve({ postId: id, starterMessageId: `msg${this.next}` });
  }

  public findForumPostByMarker(forumId: string, marker: string): Promise<string | null> {
    return Promise.resolve(this.forumPosts.find((post) => post.forumId === forumId && post.content.includes(marker))?.id ?? null);
  }

  public forumPostExists(postId: string): Promise<boolean> {
    return Promise.resolve(this.forumPosts.some((post) => post.id === postId));
  }

  public setForumPostTag(_forumId: string, postId: string, tag: string | null): Promise<void> {
    const post = this.forumPosts.find((candidate) => candidate.id === postId);
    if (post !== undefined) post.tag = tag;
    return Promise.resolve();
  }

  public archiveForumPost(postId: string, locked: boolean): Promise<void> {
    const post = this.forumPosts.find((candidate) => candidate.id === postId);
    if (post !== undefined) {
      post.archived = true;
      post.locked = locked;
    }
    return Promise.resolve();
  }
}
