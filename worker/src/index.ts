import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";

import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { startHealthServer, type WorkerStats } from "./health.js";
import { handleMessage, type JobHandlerDeps } from "./job-handler.js";
import { logger } from "./logger.js";
import { Storage } from "./storage.js";

const config = loadConfig();
const sqs = new SQSClient({
  region: config.awsRegion,
  ...(config.sqsEndpoint ? { endpoint: config.sqsEndpoint } : {}),
});
const storage = new Storage(config.awsRegion, config.mediaBucket, config.s3Endpoint);
const pool = createPool(config.db);

const stats: WorkerStats = {
  jobsSucceeded: 0,
  jobsFailed: 0,
  startedAt: new Date().toISOString(),
};

let shuttingDown = false;
const inFlight = new Set<Promise<void>>();

const VISIBILITY_TIMEOUT_SECONDS = 600;
// A generous ceiling on the whole job (download + transcode + upload + DB
// update), not just the ffmpeg subprocess — decoupled from the SQS
// visibility timeout above because the heartbeat below keeps extending that
// independently. This exists purely to guarantee a stuck job (e.g. a stalled
// S3 connection) can never strand a worker slot forever.
const JOB_TIMEOUT_MS = 12 * 60 * 1000;

/** Extends the message's visibility timeout on a fixed cadence while a job is
 * in flight, so a legitimately slow job (a large video) is never silently
 * redelivered to a second worker mid-processing — which under load is
 * exactly the scenario that wastes the most capacity twice over. Returns a
 * function that stops the heartbeat once the job settles. */
function startVisibilityHeartbeat(message: Message): () => void {
  const receiptHandle = message.ReceiptHandle;
  if (!receiptHandle) return () => {};

  const intervalMs = Math.min((VISIBILITY_TIMEOUT_SECONDS * 1000) / 2, 120_000);
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

const jobHandlerDeps: JobHandlerDeps = {
  pool,
  storage,
  logger,
  stats,
  cloudfrontDomain: config.cloudfrontDomain,
  maxReceiveCount: config.maxReceiveCount,
  jobTimeoutMs: JOB_TIMEOUT_MS,
  deleteMessage,
};

/** One lane = one continuous receive-one/process/repeat loop. `config.concurrency`
 * lanes run independently rather than sharing a single batch receive — the
 * earlier design received up to `concurrency` messages together and waited
 * for the *entire* batch to finish before receiving again, so one slow job
 * (ffmpeg can legitimately take minutes) stalled every other slot in that
 * batch instead of it immediately picking up new work. Independent lanes
 * mean a fast job's slot goes straight back to polling. */
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
    const jobPromise = handleMessage(message, jobHandlerDeps).finally(stopHeartbeat);
    inFlight.add(jobPromise);
    await jobPromise.finally(() => inFlight.delete(jobPromise));
  }
}

async function mainLoop(): Promise<void> {
  logger.info("Transcode worker started", { queueUrl: config.queueUrl, concurrency: config.concurrency });
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

  await pool.end().catch(() => {});
  logger.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Every real failure path (a bad job, a DB/S3 error) is already caught inside
// handleMessage — these are a backstop for anything outside that (a bug in a
// library, a stray rejection). Node crashes the whole process on an unhandled
// rejection by default; logging and continuing keeps the poll loop and any
// other in-flight jobs alive instead of losing them to an unrelated error.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { error: reason });
});
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error });
});

startHealthServer(config.healthPort, () => shuttingDown, stats);
void mainLoop();
