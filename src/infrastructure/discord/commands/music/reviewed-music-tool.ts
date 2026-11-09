import type { BotCommand } from "../../../../application/commands/command.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "../../../../application/chat/tools/chat-tool.js";
import { immutableSnapshot } from "../../../../application/context/immutable-snapshot.js";
import { PlayCommand } from "./play-command.js";
import { PauseCommand } from "./pause-command.js";
import { ResumeCommand } from "./resume-command.js";
import { StopCommand } from "./stop-command.js";
import { SkipCommand } from "./skip-command.js";
import { PreviousCommand } from "./previous-command.js";
import { ShuffleCommand } from "./shuffle-command.js";
import { VolumeCommand } from "./volume-command.js";
import { QueueCommand } from "./queue-command.js";

const registered = new WeakSet<object>();
// Composition reviews actual command implementations, never a tool name or
// caller-supplied marker. Adding a binding requires explicit source review.
export class ReviewedMusicTool implements ChatTool {
  public readonly name: string;
  public readonly description: string;
  public readonly parameters: ChatTool["parameters"];
  public readonly outputKind: "context" | "functional";
  private readonly invoke: ChatTool["execute"];
  private constructor(private readonly command: BotCommand) {
    const binding = command.toolBinding!;
    this.name = binding.name; this.description = binding.description;
    this.parameters = immutableSnapshot(binding.parameters); this.invoke = binding.execute.bind(binding);
    this.outputKind = command instanceof QueueCommand ? "context" : "functional";
    registered.add(this);
  }
  public static from(command: BotCommand): ReviewedMusicTool | null {
    return command instanceof PlayCommand || command instanceof PauseCommand || command instanceof ResumeCommand || command instanceof StopCommand ||
      command instanceof SkipCommand || command instanceof PreviousCommand || command instanceof ShuffleCommand || command instanceof VolumeCommand || command instanceof QueueCommand
      ? new ReviewedMusicTool(command) : null;
  }
  public static registered(tool: unknown): tool is ReviewedMusicTool { return !!tool && typeof tool === "object" && registered.has(tool); }
  public execute(args: unknown, context: ChatToolContext): Promise<ChatToolResult> { return this.invoke(args, context); }
  public readQueue(context: ChatToolContext, eligible: (userId: string) => Promise<boolean>): Promise<string | null> {
    return this.command instanceof QueueCommand ? this.command.readGuardedResource(context, eligible) : Promise.resolve(null);
  }
}
