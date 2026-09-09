import type { Config } from "./config.js";
import { logger } from "./logger.js";
import { recordEventProcessed } from "./metrics.js";
import { TrendingStore } from "./trending.js";
import type { AnalyticsEvent } from "./types.js";

export async function handleEvent(
  event: AnalyticsEvent,
  trending: TrendingStore,
  weights: Config["weights"]
): Promise<void> {
  const weight =
    event.type === "post_created"
      ? weights.postCreated
      : event.type === "post_liked"
        ? weights.postLiked
        : weights.postCommented;

  await trending.record("posts", event.postId, weight);

  if (event.tags && event.tags.length > 0) {
    await Promise.all(event.tags.map((tag) => trending.record("hashtags", tag.toLowerCase(), weight)));
  }

  logger
    .child({ correlationId: event.correlationId })
    .info("Recorded analytics event", { type: event.type, postId: event.postId, weight });
  void recordEventProcessed(event.type);
}
