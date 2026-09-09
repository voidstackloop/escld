import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./metrics.js", () => ({ recordEventProcessed: vi.fn().mockResolvedValue(undefined) }));

import { handleEvent } from "./events.js";
import type { TrendingStore } from "./trending.js";
import type { AnalyticsEvent } from "./types.js";

const weights = { postCreated: 1, postLiked: 3, postCommented: 5 };

function makeTrending(): TrendingStore {
  return { record: vi.fn().mockResolvedValue(undefined) } as unknown as TrendingStore;
}

describe("handleEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records a post_created event under the postCreated weight", async () => {
    const trending = makeTrending();
    const event: AnalyticsEvent = { type: "post_created", postId: "post-1" };

    await handleEvent(event, trending, weights);

    expect(trending.record).toHaveBeenCalledWith("posts", "post-1", 1);
  });

  it("records a post_liked event under the higher postLiked weight", async () => {
    const trending = makeTrending();
    const event: AnalyticsEvent = { type: "post_liked", postId: "post-1" };

    await handleEvent(event, trending, weights);

    expect(trending.record).toHaveBeenCalledWith("posts", "post-1", 3);
  });

  it("records a post_commented event under the highest postCommented weight", async () => {
    const trending = makeTrending();
    const event: AnalyticsEvent = { type: "post_commented", postId: "post-1" };

    await handleEvent(event, trending, weights);

    expect(trending.record).toHaveBeenCalledWith("posts", "post-1", 5);
  });

  it("also records each tag, lowercased, at the same weight", async () => {
    const trending = makeTrending();
    const event: AnalyticsEvent = { type: "post_liked", postId: "post-1", tags: ["Kittens", "FUNNY"] };

    await handleEvent(event, trending, weights);

    expect(trending.record).toHaveBeenCalledWith("hashtags", "kittens", 3);
    expect(trending.record).toHaveBeenCalledWith("hashtags", "funny", 3);
  });

  it("skips hashtag recording entirely when there are no tags", async () => {
    const trending = makeTrending();
    const event: AnalyticsEvent = { type: "post_created", postId: "post-1", tags: [] };

    await handleEvent(event, trending, weights);

    expect(trending.record).toHaveBeenCalledTimes(1);
    expect(trending.record).toHaveBeenCalledWith("posts", "post-1", 1);
  });

  it("propagates a downstream Redis failure to the caller rather than swallowing it", async () => {
    const trending = makeTrending();
    (trending.record as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("redis down"));
    const event: AnalyticsEvent = { type: "post_created", postId: "post-1" };

    await expect(handleEvent(event, trending, weights)).rejects.toThrow("redis down");
  });
});
