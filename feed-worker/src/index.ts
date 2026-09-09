import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { loadConfig } from "./config.js";
import { FeedFanout } from "./dynamo.js";
import { embedText } from "./embeddings.js";
import { SearchIndex } from "./es.js";
import { startHealthServer, type WorkerStats } from "./health.js";
import { handleMessage, type EventHandlerDeps } from "./event-handler.js";
import { logger } from "./logger.js";

const config = loadConfig();
const sqs = new SQSClient({
  region: config.awsRegion,
  ...(config.sqsEndpoint ? { endpoint: config.sqsEndpoint } : {}),
});
const dynamo = new DynamoDBClient({
  region: config.awsRegion,
  ...(config.dynamoEndpoint ? { endpoint: config.dynamoEndpoint } : {}),
});
const fanout = new FeedFanout(dynamo, config.followsTableName, config.feedTableName);
const searchIndex = new SearchIndex(config.elasticsearchUrl, config.postsIndex);

const stats: WorkerStats = {
  jobsSucceeded: 0,
  jobsFailed: 0,
  startedAt: new Date().toISOString(),
};

let shuttingDown = false;
const inFlight = new Set<Promise<void>>();

const VISIBILITY_TIMEOUT_SECONDS = 120;
// Generous relative to a normal fan-out (see FeedFanout — even a very large
// follower count finishes in well under a minute at its bounded concurrency),
// but bounded so a genuinely stuck event can't strand a lane forever.
const JOB_TIMEOUT_MS = 5 * 60 * 1000;

/** Same reasoning as the transcode worker's heartbeat: without this, a
 * fan-out to a very large follower list that runs longer than the visibility
 * timeout gets silently redelivered to a second lane mid-processing. */
function startVisibilityHeartbeat(message: Message): () => void {
  const receiptHandle = message.ReceiptHandle;
  if (!receiptHandle) return () => {};

  const intervalMs = Math.min((VISIBILITY_TIMEOUT_SECONDS * 1000) / 2, 60_000);
  const timer = setInterval(() => {
    sqs
      .send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: config.queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
        })
      )
      .catch((error: unknown) => logger.warn("Failed to extend message visibility", { error }));
  }, intervalMs);

  return () => clearInterval(timer);
}

async function deleteMessage(message: Message): Promise<void> {
  await sqs.send(new DeleteMessageCommand({ QueueUrl: config.queueUrl, ReceiptHandle: message.ReceiptHandle }));
}

const eventHandlerDeps: EventHandlerDeps = {
  fanout,
  searchIndex,
  embedText,
  logger,
  stats,
  maxReceiveCount: config.maxReceiveCount,
  jobTimeoutMs: JOB_TIMEOUT_MS,
  deleteMessage,
};

/** One lane = one continuous receive-one/process/repeat loop, run
 * `config.concurrency` at a time. The earlier design received a whole batch
 * and waited for every message in it to finish before receiving again, so a
 * slow celebrity-account fan-out stalled every other slot in that batch
 * instead of it immediately picking up new work — independent lanes fix that
 * head-of-line blocking. */
async function runLane(laneId: number): Promise<void> {
  while (!shuttingDown) {
    let message: Message | undefined;
    try {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: config.queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 20,
          VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          MessageAttributeNames: ["correlationId", "traceparent"],
        })
      );
      message = response.Messages?.[0];
    } catch (error) {
      logger.error("Lane receive error, backing off", { laneId, error });
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }

    if (!message) continue;

    const stopHeartbeat = startVisibilityHeartbeat(message);
    const jobPromise = handleMessage(message, eventHandlerDeps).finally(stopHeartbeat);
    inFlight.add(jobPromise);
    await jobPromise.finally(() => inFlight.delete(jobPromise));
  }
}

async function mainLoop(): Promise<void> {
  // Model weights are baked onto disk at build time (see Dockerfile), but
  // loading them into memory is deferred to the first real embedText() call
  // instead of happening here — an idle worker (the common case between
  // bursts of posts) shouldn't be holding the ~90MB ONNX model in RAM for
  // no reason.
  logger.info("Feed worker started", { queueUrl: config.queueUrl, concurrency: config.concurrency });
  await Promise.all(Array.from({ length: config.concurrency }, (_, laneId) => runLane(laneId)));
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Shutdown signal received, draining in-flight jobs", { signal, inFlight: inFlight.size });

  const drainTimeoutMs = 30_000;
  await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise((resolve) => setTimeout(resolve, drainTimeoutMs)),
  ]);

  logger.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Every real failure path (a bad event, an ES/DynamoDB error) is already
// caught inside handleMessage — these are a backstop for anything outside
// that (a bug in a library, a stray rejection). Node crashes the whole
// process on an unhandled rejection by default; logging and continuing keeps
// the poll loop and any other in-flight jobs alive instead of losing them to
// an unrelated error.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { error: reason });
});
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error });
});

startHealthServer(config.healthPort, () => shuttingDown, stats);
void mainLoop();
