import { createHash } from "node:crypto";

import type {
  StructuredModelClient,
  StructuredModelRequest,
  StructuredModelResponse,
} from "../../../application/campaign/ports/structured-model-client.js";

// One saved call. The key hashes what the model was asked, so a replay only
// answers a request it has seen before.
export interface RecordedCall {
  readonly key: string;
  readonly response: StructuredModelResponse;
}

export function requestKey(request: StructuredModelRequest): string {
  return createHash("sha256").update(JSON.stringify([request.schemaName, request.system, request.user])).digest("hex");
}

// Wraps a real client and keeps every call, so a live run can be saved and
// replayed later for free (plan §12, Harness: recorded model responses).
export class RecordingStructuredClient implements StructuredModelClient {
  public readonly name: string;
  public readonly calls: RecordedCall[] = [];

  public constructor(private readonly inner: StructuredModelClient) {
    this.name = `recording(${inner.name})`;
  }

  public async generate(request: StructuredModelRequest): Promise<StructuredModelResponse> {
    const response = await this.inner.generate(request);
    this.calls.push({ key: requestKey(request), response });
    return response;
  }
}

// Answers from a recording. Identical requests are answered in the order they
// were recorded. A request the recording does not hold fails loudly: a
// changed prompt or engine means the recording no longer matches and must be
// re-recorded, never silently mixed with new answers.
export class ReplayStructuredClient implements StructuredModelClient {
  public readonly name = "replay";
  private readonly queues = new Map<string, StructuredModelResponse[]>();

  public constructor(calls: readonly RecordedCall[]) {
    for (const call of calls) {
      const queue = this.queues.get(call.key) ?? [];
      queue.push(call.response);
      this.queues.set(call.key, queue);
    }
  }

  public generate(request: StructuredModelRequest): Promise<StructuredModelResponse> {
    const response = this.queues.get(requestKey(request))?.shift();
    if (response === undefined) {
      return Promise.reject(new Error(`No recorded response for this ${request.schemaName} request; re-record the run.`));
    }
    return Promise.resolve(response);
  }
}
