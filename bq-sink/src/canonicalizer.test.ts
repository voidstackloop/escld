import { describe, expect, it } from "vitest";

import { canonicalMergeSql } from "./canonicalizer.js";

describe("canonicalMergeSql", () => {
  it("unions every raw event table and merges one deterministic winner per event ID", () => {
    const sql = canonicalMergeSql("project-1", "escld_events_raw", "escld_analytics");

    expect(sql).toContain("`project-1.escld_events_raw.raw_post_impression`");
    expect(sql).toContain("`project-1.escld_events_raw.raw_post_dwell`");
    expect(sql).toContain("`project-1.escld_events_raw.raw_feed_served`");
    expect(sql).toContain("`project-1.escld_events_raw.raw_post_comment_deleted`");
    expect(sql).toContain("`project-1.escld_events_raw.raw_media_progress`");
    expect(sql).toContain("PARTITION BY eventId ORDER BY ingestedAt, sourceTopic");
    expect(sql).toContain("MERGE `project-1.escld_analytics.canonical_events`");
    expect(sql).toContain("DELETE FROM `project-1.escld_analytics.canonical_events`");
    expect(sql).toContain("MERGE `project-1.escld_analytics.event_conflicts`");
    expect(sql).toContain("candidate.eventId = target.eventId");
    expect(sql).toContain("ON target.eventId = source.eventId\nWHEN NOT MATCHED");
    expect(sql).toContain("MERGE `project-1.escld_analytics.feed_impressions`");
    expect(sql).toContain("MERGE `project-1.escld_analytics.feed_requests`");
    expect(sql).toContain("JSON_QUERY_ARRAY(request.orderedItems)");
    expect(sql).toContain("visibleDurationMs') AS INT64) >= 1000");
    expect(sql).toContain("MERGE `project-1.escld_analytics.impression_outcomes`");
    expect(sql).toContain("INTERVAL 48 HOUR");
    expect(sql).toContain("activeDwellMs >= 10000");
    expect(sql).toContain("mediaCompletionFraction >= 0.5");
    expect(sql).toContain("event.eventType = 'media.progress'");
    expect(sql).toContain("deletion.eventType = 'post.comment_deleted'");
    expect(sql).toContain("deletion.occurredAt BETWEEN comment.occurredAt");
    expect(sql.match(/PARTITION BY event\.eventId ORDER BY impression\.impressionAt DESC/g)).toHaveLength(3);
  });

  it("rejects identifiers that could escape quoted table names", () => {
    expect(() => canonicalMergeSql("project`; DROP TABLE x", "raw", "analytics")).toThrow("Unsafe");
  });

  it("partitions canonical events by ingestion time for replay-safe pruning", () => {
    const sql = canonicalMergeSql("project-1", "escld_events_raw", "escld_analytics");

    expect(sql).toContain("PARTITION BY DATE(ingestedAt)");
    expect(sql).not.toContain("PARTITION BY DATE(occurredAt)");
  });

  it("promotes typed session/request/experiment columns with payload fallback", () => {
    const sql = canonicalMergeSql("project-1", "escld_events_raw", "escld_analytics");

    expect(sql).toContain("COALESCE(sessionId, JSON_VALUE(eventPayload, '$.sessionId')) AS sessionId");
    expect(sql).toContain("COALESCE(requestId, JSON_VALUE(eventPayload, '$.requestId')) AS requestId");
    expect(sql).toContain("sessionId STRING, requestId STRING");
    expect(sql).toContain("experimentId STRING, experimentVariant STRING");
  });

  it("materializes daily reach and outcome aggregates with provisional status", () => {
    const sql = canonicalMergeSql("project-1", "escld_events_raw", "escld_analytics");

    expect(sql).toContain("MERGE `project-1.escld_analytics.post_daily`");
    expect(sql).toContain("MERGE `project-1.escld_analytics.creator_daily`");
    expect(sql).toContain("COUNT(DISTINCT actorId) AS qualifiedReach");
    expect(sql).toContain("LOGICAL_OR(provisional) AS provisional");
  });

  it("deduplicates cumulative media-progress events to a per-impression watch-time max, not a sum", () => {
    const sql = canonicalMergeSql("project-1", "escld_events_raw", "escld_analytics");

    expect(sql).toContain("MAX(SAFE_CAST(JSON_VALUE(event.payload, '$.mediaPlayedMs') AS INT64)) AS watchTimeMs");
    expect(sql).not.toMatch(/SUM\([^)]*mediaPlayedMs/);
  });

  it("carries watchTimeMs from media progress through impression_outcomes into post_daily/creator_daily", () => {
    const sql = canonicalMergeSql("project-1", "escld_events_raw", "escld_analytics");

    expect(sql).toContain("ADD COLUMN IF NOT EXISTS watchTimeMs INT64");
    expect(sql).toContain("IFNULL(media.watchTimeMs, 0) AS watchTimeMs");
    expect(sql).toContain("SUM(watchTimeMs) AS watchTimeMs");
  });

  it("computes raw like/comment counts net of unlike/deletion, independent of impression attribution", () => {
    const sql = canonicalMergeSql("project-1", "escld_events_raw", "escld_analytics");

    expect(sql).toContain("CREATE TEMP TABLE raw_engagement_daily");
    expect(sql).toContain(
      "COUNTIF(event.eventType = 'post.liked') - COUNTIF(event.eventType = 'post.unliked') AS likeCount",
    );
    expect(sql).toContain(
      "COUNTIF(event.eventType = 'post.commented') - COUNTIF(event.eventType = 'post.comment_deleted') AS commentCount",
    );
    expect(sql).toContain("FULL OUTER JOIN raw_engagement_daily USING (postId, day)");
  });

  it("computes new-follower counts net of unfollow, keyed by the followee (the creator gaining a follower)", () => {
    const sql = canonicalMergeSql("project-1", "escld_events_raw", "escld_analytics");

    expect(sql).toContain("CREATE TEMP TABLE raw_follows_daily");
    expect(sql).toContain(
      "COUNTIF(event.eventType = 'user.followed') - COUNTIF(event.eventType = 'user.unfollowed') AS newFollowerCount",
    );
    expect(sql).toContain("JSON_VALUE(event.payload, '$.followeeId') AS authorId");
    expect(sql).toContain("FULL OUTER JOIN raw_follows_daily USING (authorId, day)");
  });

  it("attributes post engagement to the post's author, not the engaging viewer, for creator_daily", () => {
    const sql = canonicalMergeSql("project-1", "escld_events_raw", "escld_analytics");

    expect(sql).toContain("post_engagement_by_author AS (");
    expect(sql).toContain("JOIN post_authors ON post_authors.postId = raw_engagement_daily.postId");
  });

  it("resolves post_authors as a standalone temp table covering both impressed and merely-engaged posts", () => {
    const sql = canonicalMergeSql("project-1", "escld_events_raw", "escld_analytics");

    expect(sql).toContain("CREATE TEMP TABLE post_authors AS");
    expect(sql).toContain("SELECT postId FROM raw_engagement_daily");
    // Must be created before it's referenced by name in the later MERGE
    // statements, not just present somewhere in the script.
    expect(sql.indexOf("CREATE TEMP TABLE post_authors")).toBeLessThan(
      sql.indexOf("MERGE `project-1.escld_analytics.impression_outcomes`"),
    );
  });

  it("carries experimentId/experimentVariant from canonical_events through feed_requests", () => {
    const sql = canonicalMergeSql("project-1", "escld_events_raw", "escld_analytics");

    expect(sql).toContain("experimentId STRING, experimentVariant STRING,\n  materializedAt TIMESTAMP NOT NULL");
    expect(sql).toContain(
      "INSERT (lineageEventId, requestId, actorId, servedAt, itemCount, continuation,\n  servedFromSnapshot, hasMore, orderedItems, experimentId, experimentVariant, materializedAt)",
    );
  });

  it("rolls impression_outcomes up by experiment/variant/day via feed_requests, defaulting untagged requests to 'unassigned'", () => {
    const sql = canonicalMergeSql("project-1", "escld_events_raw", "escld_analytics");

    expect(sql).toContain("MERGE `project-1.escld_analytics.experiment_daily`");
    expect(sql).toContain("IFNULL(request.experimentId, 'unassigned') AS experimentId");
    expect(sql).toContain("IFNULL(request.experimentVariant, 'unassigned') AS experimentVariant");
    expect(sql).toContain(
      "JOIN `project-1.escld_analytics.feed_requests` AS request\n    ON request.requestId = outcome.requestId AND request.actorId = outcome.actorId",
    );
    expect(sql).toContain("GROUP BY experimentId, experimentVariant, day");
    // Must run after feed_requests/impression_outcomes are both populated,
    // not concurrently with them.
    expect(sql.indexOf("MERGE `project-1.escld_analytics.experiment_daily`")).toBeGreaterThan(
      sql.indexOf("MERGE `project-1.escld_analytics.impression_outcomes`"),
    );
  });
});
