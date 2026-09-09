import { randomUUID } from "node:crypto";

import type { Message } from "@aws-sdk/client-sqs";

import type { WorkerStats } from "./health.js";
import type { Logger } from "./logger.js";
import { recordEventResult } from "./metrics.js";
import { traceMessageProcessing } from "./tracing.js";
import { isPostCreatedEvent, type PostCreatedEvent } from "./types.js";

/** Narrow views of FeedFanout/SearchIndex/embedText — let tests pass plain
 * mocks instead of a real DynamoDB/Elasticsearch client or ONNX model. */
export interface FeedFanoutLike {
  listFollowers(authorId: string): Promise<string[]>;
  fanout(recipientIds: string[], postId: string, authorId: string, createdAt: string): Promise<void>;
}

export interface SearchIndexLike {
  indexPost(
    postId: string,
    doc: { userId: string; text: string; tags: string[]; createdAt: string; embedding: number[] }
  ): Promise<void>;
}

export interface EventHandlerDeps {
  fanout: FeedFanoutLike;
  searchIndex: SearchIndexLike;
  embedText: (text: string) => Promise<number[] | null>;
  logger: Logger;
  stats: WorkerStats;
  maxReceiveCount: number;
  jobTimeoutMs: number;
  deleteMessage: (message: Message) => Promise<void>;
}

/** Guarantees the caller gets control back even if `fn` never settles, so one
 * hung event can only ever cost this lane jobTimeoutMs, not its remaining
 * lifetime. Unlike the transcode worker, nothing here listens for an abort
 * signal (the ES/DynamoDB SDK calls aren't wired to it) — the underlying work
 * keeps running detached until it finishes on its own, which is safe because
 * both the ES index write and the DynamoDB fan-out are idempotent, but it
 * does mean this bounds lane availability, not the wasted work itself. */
async function withDeadline<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Job exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function processEvent(event: PostCreatedEvent, eventLogger: Logger, deps: EventHandlerDeps): Promise<void> {
  const startedAt = Date.now();
  eventLogger.info("Post event started");

  // Embedding/indexing failures must not prevent followed posts appearing in
  // feeds: fan-out is the availability-critical path, search is best-effort.
  // Indexing retries via SQS redrive/DLQ evidence only when fan-out also
  // fails; an isolated indexing failure is logged and fan-out still runs.
  try {
    const embedding = await deps.embedText(event.text);
    if (embedding === null) {
      eventLogger.info("Skipping search index for textless post; continuing to fan-out");
    } else {
      await deps.searchIndex.indexPost(event.postId, {
        userId: event.authorId,
        text: event.text,
        tags: event.tags,
        createdAt: event.createdAt,
        embedding,
      });
    }
  } catch (error) {
    eventLogger.error("Search indexing failed; continuing to fan-out", { error });
  }

  const followerIds = await deps.fanout.listFollowers(event.authorId);
  // The author sees their own posts in their feed too, same as every other
  // social feed — not just what they follow.
  const recipients = [...new Set([...followerIds, event.authorId])];
  await deps.fanout.fanout(recipients, event.postId, event.authorId, event.createdAt);

  deps.stats.jobsSucceeded += 1;
  eventLogger.info("Post event finished", {
    recipientCount: recipients.length,
    durationMs: Date.now() - startedAt,
  });
}

/** Wrapped in traceMessageProcessing (see tracing.ts) so this event's spans —
 * and everything ADOT auto-instruments inside it (Elasticsearch, DynamoDB) —
 * link back to the request that originally enqueued it, rather than
 * starting a disconnected trace. */
export async function handleMessage(message: Message, deps: EventHandlerDeps): Promise<void> {
  return traceMessageProcessing(message, "process post-created event", () => processMessage(message, deps));
}

async function processMessage(message: Message, deps: EventHandlerDeps): Promise<void> {
  const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? "1", 10);
  const isFinalAttempt = receiveCount >= deps.maxReceiveCount;
  const startedAt = Date.now();

  // Same reasoning as the transcode worker — carried as an SQS message
  // attribute (see PostEventPublisher on the backend), falls back to a
  // fresh ID for messages already in flight before this was added.
  const correlationId = message.MessageAttributes?.correlationId?.StringValue ?? randomUUID();
  const eventLogger = deps.logger.child({ correlationId });

  try {
    const parsed: unknown = JSON.parse(message.Body ?? "");
    if (!isPostCreatedEvent(parsed)) {
      throw new Error("Message body is not a valid PostCreatedEvent");
    }
    const postLogger = eventLogger.child({ postId: parsed.postId, authorId: parsed.authorId });

    await withDeadline(() => processEvent(parsed, postLogger, deps), deps.jobTimeoutMs);
    await deps.deleteMessage(message);
    void recordEventResult("success", Date.now() - startedAt);
  } catch (error) {
    eventLogger.error("Post event failed", { receiveCount, isFinalAttempt, error });
    deps.stats.jobsFailed += 1;
    void recordEventResult("failure", Date.now() - startedAt);

    if (isFinalAttempt) {
      // Last attempt — leave the message alone so SQS's redrive policy moves
      // it to the DLQ for inspection instead of us deleting the evidence.
      // Unlike the transcode worker there's no Postgres status to flip: the
      // post itself is unaffected, it's just missing from feeds/search until
      // manually reprocessed.
      eventLogger.error("Post event permanently failed, will move to DLQ", { messageId: message.MessageId });
    }
    // Non-final attempts: don't delete. SQS's visibility timeout expiring
    // makes it eligible for another receive automatically.
  }
}
