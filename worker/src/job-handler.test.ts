import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@aws-sdk/client-sqs";
import type { Pool } from "pg";

vi.mock("./metrics.js", () => ({ recordJobResult: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./ffmpeg.js", () => ({ transcodeToHls: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./db.js", () => ({
  markReady: vi.fn().mockResolvedValue(undefined),
  markFailed: vi.fn().mockResolvedValue(undefined),
}));

import { markFailed, markReady } from "./db.js";
import { handleMessage, type JobHandlerDeps, type StorageLike } from "./job-handler.js";
import type { WorkerStats } from "./health.js";
import type { Logger } from "./logger.js";

function makeLogger(): Logger {
  const noop: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => noop,
  };
  return noop;
}

function makeDeps(overrides: Partial<JobHandlerDeps> = {}): JobHandlerDeps {
  const storage: StorageLike = {
    download: vi.fn().mockResolvedValue(undefined),
    uploadDirectory: vi.fn().mockResolvedValue(undefined),
  };
  const stats: WorkerStats = { jobsSucceeded: 0, jobsFailed: 0, startedAt: new Date().toISOString() };
  return {
    pool: {} as Pool,
    storage,
    logger: makeLogger(),
    stats,
    cloudfrontDomain: "cdn.example.com",
    maxReceiveCount: 3,
    jobTimeoutMs: 5000,
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeMessage(body: unknown, attrs: Record<string, unknown> = {}): Message {
  return {
    Body: JSON.stringify(body),
    ReceiptHandle: "receipt-1",
    Attributes: attrs as Message["Attributes"],
    MessageAttributes: {},
  };
}

describe("handleMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes a valid job: downloads, transcodes, uploads, marks ready, deletes the message", async () => {
    const deps = makeDeps();
    const message = makeMessage({ postId: "post-1", mediaKey: "key-1", mediaType: "VIDEO" });

    await handleMessage(message, deps);

    expect(deps.storage.download).toHaveBeenCalledWith("key-1", expect.any(String), expect.any(AbortSignal));
    expect(deps.storage.uploadDirectory).toHaveBeenCalledWith(
      expect.any(String),
      "posts/post-1/hls",
      expect.any(AbortSignal)
    );
    expect(markReady).toHaveBeenCalledWith(deps.pool, "post-1", "https://cdn.example.com/posts/post-1/hls/master.m3u8");
    expect(deps.deleteMessage).toHaveBeenCalledWith(message);
    expect(deps.stats.jobsSucceeded).toBe(1);
    expect(deps.stats.jobsFailed).toBe(0);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("drops a malformed message without deleting it or touching Postgres, on a non-final attempt", async () => {
    const deps = makeDeps();
    const message = makeMessage({ postId: "post-1" }, { ApproximateReceiveCount: "1" });

    await handleMessage(message, deps);

    expect(deps.deleteMessage).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(deps.stats.jobsFailed).toBe(1);
  });

  it("marks the post FAILED only once the final receive attempt is reached", async () => {
    const deps = makeDeps({ maxReceiveCount: 3 });
    (deps.storage.download as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("s3 down"));
    const job = { postId: "post-1", mediaKey: "key-1", mediaType: "VIDEO" };

    await handleMessage(makeMessage(job, { ApproximateReceiveCount: "2" }), deps);
    expect(markFailed).not.toHaveBeenCalled();
    expect(deps.deleteMessage).not.toHaveBeenCalled();

    await handleMessage(makeMessage(job, { ApproximateReceiveCount: "3" }), deps);
    expect(markFailed).toHaveBeenCalledWith(deps.pool, "post-1");
    expect(deps.deleteMessage).not.toHaveBeenCalled();
  });

  it("does not let a markFailed failure escape handleMessage", async () => {
    const deps = makeDeps({ maxReceiveCount: 1 });
    (deps.storage.download as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("s3 down"));
    (markFailed as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db also down"));
    const message = makeMessage(
      { postId: "post-1", mediaKey: "key-1", mediaType: "VIDEO" },
      { ApproximateReceiveCount: "1" }
    );

    await expect(handleMessage(message, deps)).resolves.toBeUndefined();
  });
});
