import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { Message } from "@aws-sdk/client-sqs";
import type { Pool } from "pg";

import { markFailed, markReady } from "./db.js";
import { transcodeToHls } from "./ffmpeg.js";
import type { WorkerStats } from "./health.js";
import type { Logger } from "./logger.js";
import { recordJobResult } from "./metrics.js";
import { traceMessageProcessing } from "./tracing.js";
import { isTranscodeJob, type TranscodeJob } from "./types.js";

/** Narrow view of Storage — lets tests pass a plain mock instead of a real S3 client. */
export interface StorageLike {
  download(key: string, destPath: string, signal?: AbortSignal): Promise<void>;
  uploadDirectory(localDir: string, s3Prefix: string, signal?: AbortSignal): Promise<void>;
}

export interface JobHandlerDeps {
  pool: Pool;
  storage: StorageLike;
  logger: Logger;
  stats: WorkerStats;
  cloudfrontDomain: string;
  maxReceiveCount: number;
  jobTimeoutMs: number;
  deleteMessage: (message: Message) => Promise<void>;
}

/** Runs `fn` with an AbortSignal that fires after `timeoutMs`, guaranteeing
 * the caller gets control back even if `fn` never settles on its own. Note
 * this only truly cancels work that actually listens for the signal (the S3
 * calls and the ffmpeg subprocess do); it does not kill a hung Postgres
 * query, but statement_timeout on the pool already bounds that separately. */
async function withDeadline<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Job exceeded ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function processJob(
  job: TranscodeJob,
  signal: AbortSignal,
  jobLogger: Logger,
  deps: JobHandlerDeps
): Promise<void> {
  const { postId, mediaKey } = job;
  const startedAt = Date.now();
  jobLogger.info("Transcode started", { mediaType: job.mediaType });

  const workDir = await mkdtemp(path.join(tmpdir(), "transcode-"));
  const inputPath = path.join(workDir, "source");
  const outputDir = path.join(workDir, "hls");

  try {
    await deps.storage.download(mediaKey, inputPath, signal);
    await transcodeToHls(inputPath, outputDir, jobLogger, signal);

    const s3Prefix = `posts/${postId}/hls`;
    await deps.storage.uploadDirectory(outputDir, s3Prefix, signal);

    const masterUrl = `https://${deps.cloudfrontDomain}/${s3Prefix}/master.m3u8`;
    await markReady(deps.pool, postId, masterUrl);

    deps.stats.jobsSucceeded += 1;
    jobLogger.info("Transcode finished", { masterUrl, durationMs: Date.now() - startedAt });
  } finally {
    // Best-effort cleanup — a failure here (e.g. disk pressure) shouldn't mask
    // whatever the job itself actually did, but it's worth a trace: silently
    // leaked temp directories are exactly the kind of thing that only shows
    // up much later as "why is this box out of disk."
    await rm(workDir, { recursive: true, force: true }).catch((error: unknown) =>
      jobLogger.warn("Failed to clean up temp work directory", { workDir, error })
    );
  }
}

/** Marks the post FAILED only once SQS has genuinely given up on this message
 * (i.e. this was its last allowed attempt) — earlier attempts fail silently
 * from the client's point of view and just retry, since transient errors
 * (a flaky S3 read, a DB hiccup) shouldn't surface as a permanent failure.
 *
 * Wrapped in traceMessageProcessing (see tracing.ts) so this job's spans —
 * and everything ADOT auto-instruments inside it (S3, Postgres) — link back
 * to the request that originally enqueued it, rather than starting a
 * disconnected trace. */
export async function handleMessage(message: Message, deps: JobHandlerDeps): Promise<void> {
  return traceMessageProcessing(message, "process transcode job", () => processMessage(message, deps));
}

async function processMessage(message: Message, deps: JobHandlerDeps): Promise<void> {
  const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? "1", 10);
  const isFinalAttempt = receiveCount >= deps.maxReceiveCount;
  const startedAt = Date.now();

  // Carried as an SQS message attribute (see TranscodeJobPublisher on the
  // backend), not a body field, so it survives DLQ/redrive without touching
  // the payload schema. Falls back to a fresh ID for messages already in
  // flight before this was added, or if a message was hand-published.
  const correlationId = message.MessageAttributes?.correlationId?.StringValue ?? randomUUID();
  const jobLogger = deps.logger.child({ correlationId });

  let job: TranscodeJob | undefined;
  try {
    const parsed: unknown = JSON.parse(message.Body ?? "");
    if (!isTranscodeJob(parsed)) {
      throw new Error("Message body is not a valid TranscodeJob");
    }
    job = parsed;
    const postLogger = jobLogger.child({ postId: job.postId, mediaKey: job.mediaKey });

    await withDeadline((signal) => processJob(job!, signal, postLogger, deps), deps.jobTimeoutMs);
    await deps.deleteMessage(message);
    void recordJobResult("success", Date.now() - startedAt);
  } catch (error) {
    jobLogger.error("Job failed", { job, receiveCount, isFinalAttempt, error });
    deps.stats.jobsFailed += 1;
    void recordJobResult("failure", Date.now() - startedAt);

    if (isFinalAttempt) {
      // Last attempt — record the failure so the UI stops showing "processing",
      // then leave the message alone so SQS's redrive policy moves it to the
      // DLQ for later inspection, instead of us deleting the evidence.
      if (job) {
        await markFailed(deps.pool, job.postId).catch((dbError: unknown) =>
          jobLogger.error("Also failed to mark post FAILED in Postgres", { postId: job?.postId, error: dbError })
        );
      } else {
        // Unparsable message on its last attempt — nothing to mark, just let it drop to the DLQ.
      }
    }
    // Non-final attempts: don't delete. SQS's visibility timeout expiring makes
    // it eligible for another receive automatically.
  }
}
