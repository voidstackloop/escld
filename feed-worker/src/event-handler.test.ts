import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@aws-sdk/client-sqs";

vi.mock("./metrics.js", () => ({ recordEventResult: vi.fn().mockResolvedValue(undefined) }));

import {
  handleMessage,
  type EventHandlerDeps,
  type FeedFanoutLike,
  type SearchIndexLike,
} from "./event-handler.js";
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

function makeDeps(overrides: Partial<EventHandlerDeps> = {}): EventHandlerDeps {
  const fanout: FeedFanoutLike = {
    listFollowers: vi.fn().mockResolvedValue(["follower-1", "follower-2"]),
    fanout: vi.fn().mockResolvedValue(undefined),
  };
  const searchIndex: SearchIndexLike = {
    indexPost: vi.fn().mockResolvedValue(undefined),
  };
  const stats: WorkerStats = { jobsSucceeded: 0, jobsFailed: 0, startedAt: new Date().toISOString() };
  return {
    fanout,
    searchIndex,
    embedText: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    logger: makeLogger(),
    stats,
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

const validEvent = {
  eventType: "CREATED",
  postId: "post-1",
  authorId: "author-1",
  text: "hello world",
  tags: ["tag1"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("handleMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("embeds, indexes, fans out to followers + the author, and deletes the message", async () => {
    const deps = makeDeps();

    await handleMessage(makeMessage(validEvent), deps);

    expect(deps.embedText).toHaveBeenCalledWith("hello world");
    expect(deps.searchIndex.indexPost).toHaveBeenCalledWith(
      "post-1",
      expect.objectContaining({ userId: "author-1", text: "hello world", tags: ["tag1"] })
    );
    expect(deps.fanout.listFollowers).toHaveBeenCalledWith("author-1");
    // Author included alongside followers, deduped.
    const call = (deps.fanout.fanout as ReturnType<typeof vi.fn>).mock.calls[0] as [string[], ...unknown[]];
    expect(new Set(call[0])).toEqual(new Set(["follower-1", "follower-2", "author-1"]));
    expect(deps.deleteMessage).toHaveBeenCalled();
    expect(deps.stats.jobsSucceeded).toBe(1);
  });

  it("drops a malformed event without deleting the message", async () => {
    const deps = makeDeps();

    await handleMessage(makeMessage({ postId: "post-1" }), deps);

    expect(deps.embedText).not.toHaveBeenCalled();
    expect(deps.deleteMessage).not.toHaveBeenCalled();
    expect(deps.stats.jobsFailed).toBe(1);
  });

  it("on an indexing failure (Elasticsearch/embed), still fans out and deletes the message", async () => {
    const deps = makeDeps();
    (deps.searchIndex.indexPost as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ES down"));

    await handleMessage(makeMessage(validEvent, { ApproximateReceiveCount: "1" }), deps);

    // Fan-out is availability-critical; search is best-effort.
    expect(deps.fanout.fanout).toHaveBeenCalled();
    expect(deps.deleteMessage).toHaveBeenCalled();
    expect(deps.stats.jobsSucceeded).toBe(1);
  });

  it("on an embedding failure, still fans out and deletes the message", async () => {
    const deps = makeDeps();
    (deps.embedText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("model down"));

    await handleMessage(makeMessage(validEvent, { ApproximateReceiveCount: "1" }), deps);

    expect(deps.fanout.fanout).toHaveBeenCalled();
    expect(deps.deleteMessage).toHaveBeenCalled();
    expect(deps.stats.jobsSucceeded).toBe(1);
  });

  it("skips search indexing for textless posts but still fans out", async () => {
    const deps = makeDeps();
    (deps.embedText as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await handleMessage(makeMessage(validEvent, { ApproximateReceiveCount: "1" }), deps);

    expect(deps.searchIndex.indexPost).not.toHaveBeenCalled();
    expect(deps.fanout.fanout).toHaveBeenCalled();
    expect(deps.deleteMessage).toHaveBeenCalled();
    expect(deps.stats.jobsSucceeded).toBe(1);
  });

  it("logs a permanent-failure message once the final receive attempt is reached, but still leaves the message for the DLQ", async () => {
    const deps = makeDeps({ maxReceiveCount: 2 });
    (deps.fanout.fanout as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("dynamo down"));

    await handleMessage(makeMessage(validEvent, { ApproximateReceiveCount: "2" }), deps);

    expect(deps.deleteMessage).not.toHaveBeenCalled();
    expect(deps.stats.jobsFailed).toBe(1);
  });
});
