const RAW_TABLES: ReadonlyArray<readonly [string, string]> = [
  ["raw_post_created", "post.created"],
  ["raw_post_liked", "post.liked"],
  ["raw_post_unliked", "post.unliked"],
  ["raw_post_commented", "post.commented"],
  ["raw_post_comment_deleted", "post.comment_deleted"],
  ["raw_post_hidden", "post.hidden"],
  ["raw_post_unhidden", "post.unhidden"],
  ["raw_user_followed", "user.followed"],
  ["raw_user_unfollowed", "user.unfollowed"],
  ["raw_live_started", "live.started"],
  ["raw_live_ended", "live.ended"],
  ["raw_post_impression", "post.impression"],
  ["raw_post_dwell", "post.dwell"],
  ["raw_feed_served", "feed.served"],
  ["raw_media_progress", "media.progress"],
];

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) throw new Error(`Unsafe BigQuery identifier: ${value}`);
  return value;
}

/** Builds the idempotent raw-to-canonical reconciliation query. */
export function canonicalMergeSql(projectId: string, rawDataset: string, analyticsDataset: string): string {
  const project = identifier(projectId);
  const raw = identifier(rawDataset);
  const analytics = identifier(analyticsDataset);
  const union = RAW_TABLES.map(([table, eventType]) => `
    SELECT eventId, '${eventType}' AS eventType, eventVersion, occurredAt,
      COALESCE(ingestedAt, occurredAt) AS ingestedAt, producer, actorId, entityType,
      entityId, entityVersion, correlationId,
      COALESCE(sessionId, JSON_VALUE(eventPayload, '$.sessionId')) AS sessionId,
      COALESCE(requestId, JSON_VALUE(eventPayload, '$.requestId')) AS requestId,
      COALESCE(experimentId, JSON_VALUE(eventPayload, '$.experimentId')) AS experimentId,
      COALESCE(experimentVariant, JSON_VALUE(eventPayload, '$.experimentVariant')) AS experimentVariant,
      eventPayload AS payload,
      SHA256(TO_JSON_STRING(eventPayload)) AS payloadHash,
      sourceTopic, sourcePartition, sourceOffset
    FROM \`${project}.${raw}.${table}\`
    WHERE COALESCE(ingestedAt, occurredAt) >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @lookbackDays DAY)
  `).join("\nUNION ALL\n");

  return `
CREATE TABLE IF NOT EXISTS \`${project}.${analytics}.canonical_events\` (
  eventId STRING NOT NULL, eventType STRING NOT NULL, eventVersion STRING NOT NULL,
  occurredAt TIMESTAMP NOT NULL, ingestedAt TIMESTAMP NOT NULL, producer STRING,
  actorId STRING, entityType STRING, entityId STRING, entityVersion INT64,
  correlationId STRING, sessionId STRING, requestId STRING,
  experimentId STRING, experimentVariant STRING,
  payload JSON, payloadHash BYTES, sourceTopic STRING,
  sourcePartition INT64, sourceOffset STRING, canonicalizedAt TIMESTAMP NOT NULL
)
PARTITION BY DATE(ingestedAt)
CLUSTER BY eventType, actorId, entityId;

CREATE TABLE IF NOT EXISTS \`${project}.${analytics}.event_conflicts\` (
  eventId STRING NOT NULL, firstSeenAt TIMESTAMP NOT NULL, lastSeenAt TIMESTAMP NOT NULL,
  payloadVariants INT64 NOT NULL, eventTypes ARRAY<STRING>, detectedAt TIMESTAMP NOT NULL
)
PARTITION BY DATE(detectedAt)
CLUSTER BY eventId;

CREATE TEMP TABLE candidate_events AS
${union};

CREATE TEMP TABLE current_conflicts AS
WITH compared AS (
  SELECT eventId, eventType, ingestedAt, payloadHash FROM candidate_events
  UNION ALL
  SELECT target.eventId, target.eventType, target.ingestedAt, target.payloadHash
  FROM \`${project}.${analytics}.canonical_events\` AS target
  WHERE EXISTS (SELECT 1 FROM candidate_events AS candidate WHERE candidate.eventId = target.eventId)
)
SELECT eventId, MIN(ingestedAt) AS firstSeenAt, MAX(ingestedAt) AS lastSeenAt,
  COUNT(DISTINCT IFNULL(TO_HEX(payloadHash), 'missing')) AS payloadVariants,
  ARRAY_AGG(DISTINCT eventType ORDER BY eventType) AS eventTypes
FROM compared
GROUP BY eventId
HAVING payloadVariants > 1 OR ARRAY_LENGTH(eventTypes) > 1;

MERGE \`${project}.${analytics}.event_conflicts\` AS target
USING current_conflicts AS source
ON target.eventId = source.eventId
WHEN MATCHED THEN UPDATE SET lastSeenAt = source.lastSeenAt,
  payloadVariants = source.payloadVariants, eventTypes = source.eventTypes, detectedAt = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (eventId, firstSeenAt, lastSeenAt, payloadVariants, eventTypes, detectedAt)
VALUES (source.eventId, source.firstSeenAt, source.lastSeenAt, source.payloadVariants,
  source.eventTypes, CURRENT_TIMESTAMP());

DELETE FROM \`${project}.${analytics}.canonical_events\`
WHERE eventId IN (SELECT eventId FROM current_conflicts);

CREATE TEMP TABLE winners AS
SELECT * EXCEPT(dedupRank)
FROM (
  SELECT candidate_events.*,
    ROW_NUMBER() OVER (PARTITION BY eventId ORDER BY ingestedAt, sourceTopic,
      sourcePartition, SAFE_CAST(sourceOffset AS INT64)) AS dedupRank
  FROM candidate_events
  WHERE eventId NOT IN (SELECT eventId FROM current_conflicts)
    AND eventId NOT IN (SELECT eventId FROM \`${project}.${analytics}.event_conflicts\`)
)
WHERE dedupRank = 1;

MERGE \`${project}.${analytics}.canonical_events\` AS target
USING winners AS source
ON target.eventId = source.eventId
WHEN NOT MATCHED THEN INSERT (eventId, eventType, eventVersion, occurredAt, ingestedAt,
  producer, actorId, entityType, entityId, entityVersion, correlationId,
  sessionId, requestId, experimentId, experimentVariant,
  payload, payloadHash, sourceTopic, sourcePartition, sourceOffset, canonicalizedAt)
VALUES (source.eventId, source.eventType, source.eventVersion, source.occurredAt,
  source.ingestedAt, source.producer, source.actorId, source.entityType, source.entityId,
  source.entityVersion, source.correlationId,
  source.sessionId, source.requestId, source.experimentId, source.experimentVariant,
  source.payload, source.payloadHash,
  source.sourceTopic, source.sourcePartition, source.sourceOffset, CURRENT_TIMESTAMP());

CREATE TABLE IF NOT EXISTS \`${project}.${analytics}.feed_impressions\` (
  impressionId STRING NOT NULL, actorId STRING NOT NULL, postId STRING NOT NULL,
  requestId STRING NOT NULL, sessionId STRING, position INT64 NOT NULL,
  impressionAt TIMESTAMP NOT NULL, visibleDurationMs INT64 NOT NULL,
  visibleFraction FLOAT64 NOT NULL, source STRING, reasonCode STRING,
  materializedAt TIMESTAMP NOT NULL
)
PARTITION BY DATE(impressionAt)
CLUSTER BY actorId, postId, requestId;

CREATE TABLE IF NOT EXISTS \`${project}.${analytics}.feed_requests\` (
  lineageEventId STRING NOT NULL, requestId STRING NOT NULL, actorId STRING NOT NULL, servedAt TIMESTAMP NOT NULL,
  itemCount INT64 NOT NULL, continuation BOOL NOT NULL, servedFromSnapshot BOOL NOT NULL,
  hasMore BOOL NOT NULL, orderedItems JSON NOT NULL, materializedAt TIMESTAMP NOT NULL
)
PARTITION BY DATE(servedAt)
CLUSTER BY actorId, requestId;

CREATE TABLE IF NOT EXISTS \`${project}.${analytics}.impression_outcomes\` (
  impressionId STRING NOT NULL, actorId STRING NOT NULL, postId STRING NOT NULL,
  authorId STRING, requestId STRING NOT NULL, sessionId STRING, position INT64 NOT NULL,
  impressionAt TIMESTAMP NOT NULL, activeDwellMs INT64 NOT NULL, liked BOOL NOT NULL,
  mediaCompletionFraction FLOAT64 NOT NULL, commented BOOL NOT NULL, hidden BOOL NOT NULL, attributedFollow BOOL NOT NULL,
  meaningful BOOL NOT NULL, labelMaturedAt TIMESTAMP NOT NULL, provisional BOOL NOT NULL,
  computedAt TIMESTAMP NOT NULL
)
PARTITION BY DATE(impressionAt)
CLUSTER BY actorId, postId, authorId;

ALTER TABLE \`${project}.${analytics}.impression_outcomes\`
ADD COLUMN IF NOT EXISTS mediaCompletionFraction FLOAT64;

-- Deduplicated per-impression watch time (see the media_progress CTE's own
-- MAX-per-impression comment) — the raw material creator_daily/post_daily's
-- watchTimeMs aggregates below actually sum.
ALTER TABLE \`${project}.${analytics}.impression_outcomes\`
ADD COLUMN IF NOT EXISTS watchTimeMs INT64;

DELETE FROM \`${project}.${analytics}.impression_outcomes\`
WHERE impressionId IN (
  SELECT eventId FROM \`${project}.${analytics}.event_conflicts\`
  WHERE detectedAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @lookbackDays DAY)
);
DELETE FROM \`${project}.${analytics}.feed_impressions\`
WHERE impressionId IN (
  SELECT eventId FROM \`${project}.${analytics}.event_conflicts\`
  WHERE detectedAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @lookbackDays DAY)
);

DELETE FROM \`${project}.${analytics}.feed_requests\`
WHERE lineageEventId IN (
  SELECT eventId FROM \`${project}.${analytics}.event_conflicts\`
  WHERE detectedAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @lookbackDays DAY)
);

MERGE \`${project}.${analytics}.feed_requests\` AS target
USING (
  SELECT eventId AS lineageEventId,
    COALESCE(requestId, JSON_VALUE(payload, '$.requestId')) AS requestId,
    actorId, occurredAt AS servedAt,
    SAFE_CAST(JSON_VALUE(payload, '$.itemCount') AS INT64) AS itemCount,
    IFNULL(SAFE_CAST(JSON_VALUE(payload, '$.continuation') AS BOOL), FALSE) AS continuation,
    IFNULL(SAFE_CAST(JSON_VALUE(payload, '$.servedFromSnapshot') AS BOOL), FALSE) AS servedFromSnapshot,
    IFNULL(SAFE_CAST(JSON_VALUE(payload, '$.hasMore') AS BOOL), FALSE) AS hasMore,
    JSON_QUERY(payload, '$.orderedItems') AS orderedItems
  FROM \`${project}.${analytics}.canonical_events\`
  WHERE eventType = 'feed.served'
    AND ingestedAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @lookbackDays DAY)
    AND actorId IS NOT NULL
    AND COALESCE(requestId, JSON_VALUE(payload, '$.requestId')) IS NOT NULL
    AND JSON_QUERY(payload, '$.orderedItems') IS NOT NULL
) AS source
ON target.requestId = source.requestId
WHEN NOT MATCHED THEN INSERT (lineageEventId, requestId, actorId, servedAt, itemCount, continuation,
  servedFromSnapshot, hasMore, orderedItems, materializedAt)
VALUES (source.lineageEventId, source.requestId, source.actorId, source.servedAt, source.itemCount, source.continuation,
  source.servedFromSnapshot, source.hasMore, source.orderedItems, CURRENT_TIMESTAMP());

MERGE \`${project}.${analytics}.feed_impressions\` AS target
USING (
  SELECT event.eventId AS impressionId, event.actorId,
    JSON_VALUE(event.payload, '$.postId') AS postId,
    COALESCE(event.requestId, JSON_VALUE(event.payload, '$.requestId')) AS requestId,
    COALESCE(event.sessionId, JSON_VALUE(event.payload, '$.sessionId')) AS sessionId,
    SAFE_CAST(JSON_VALUE(event.payload, '$.position') AS INT64) AS position,
    event.occurredAt AS impressionAt,
    SAFE_CAST(JSON_VALUE(event.payload, '$.visibleDurationMs') AS INT64) AS visibleDurationMs,
    SAFE_CAST(JSON_VALUE(event.payload, '$.visibleFraction') AS FLOAT64) AS visibleFraction,
    (SELECT JSON_VALUE(item, '$.source')
      FROM UNNEST(JSON_QUERY_ARRAY(request.orderedItems)) AS item
      WHERE JSON_VALUE(item, '$.postId') = JSON_VALUE(event.payload, '$.postId')
        AND SAFE_CAST(JSON_VALUE(item, '$.position') AS INT64) =
          SAFE_CAST(JSON_VALUE(event.payload, '$.position') AS INT64)
      LIMIT 1) AS source,
    (SELECT JSON_VALUE(item, '$.reasonCode')
      FROM UNNEST(JSON_QUERY_ARRAY(request.orderedItems)) AS item
      WHERE JSON_VALUE(item, '$.postId') = JSON_VALUE(event.payload, '$.postId')
        AND SAFE_CAST(JSON_VALUE(item, '$.position') AS INT64) =
          SAFE_CAST(JSON_VALUE(event.payload, '$.position') AS INT64)
      LIMIT 1) AS reasonCode
  FROM \`${project}.${analytics}.canonical_events\` AS event
  LEFT JOIN \`${project}.${analytics}.feed_requests\` AS request
    ON request.requestId = COALESCE(event.requestId, JSON_VALUE(event.payload, '$.requestId'))
    AND request.actorId = event.actorId
  WHERE event.eventType = 'post.impression'
    AND event.ingestedAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @lookbackDays DAY)
    AND SAFE_CAST(JSON_VALUE(event.payload, '$.visibleDurationMs') AS INT64) >= 1000
    AND SAFE_CAST(JSON_VALUE(event.payload, '$.visibleFraction') AS FLOAT64) >= 0.5
    AND event.actorId IS NOT NULL
    AND JSON_VALUE(event.payload, '$.postId') IS NOT NULL
    AND COALESCE(event.requestId, JSON_VALUE(event.payload, '$.requestId')) IS NOT NULL
) AS source
ON target.impressionId = source.impressionId
WHEN NOT MATCHED THEN INSERT (impressionId, actorId, postId, requestId, sessionId,
  position, impressionAt, visibleDurationMs, visibleFraction, source, reasonCode, materializedAt)
VALUES (source.impressionId, source.actorId, source.postId, source.requestId, source.sessionId,
  source.position, source.impressionAt, source.visibleDurationMs, source.visibleFraction,
  source.source, source.reasonCode, CURRENT_TIMESTAMP());

-- Raw like/comment counts, computed directly from canonical_events rather
-- than through impression_outcomes: a like or comment counts on its own
-- terms (Creator Studio's "how many likes/comments" ask), independent of
-- whether it happens to be attributable to one specific tracked impression
-- within the 24h attribution window impression_outcomes uses for
-- "meaningful engagement". Net of unlike/comment-deletion, same day only —
-- a like placed one day and undone the next nets to zero on neither day,
-- matching how every other net counter in this app already behaves (see
-- Post.likeCount's own increment/decrement pattern). Computed before
-- post_authors below so post_authors can resolve authors for engaged posts
-- that have zero tracked impressions, not just impressed ones.
CREATE TEMP TABLE raw_engagement_daily AS
SELECT JSON_VALUE(event.payload, '$.postId') AS postId,
  DATE(event.occurredAt) AS day,
  COUNTIF(event.eventType = 'post.liked') - COUNTIF(event.eventType = 'post.unliked') AS likeCount,
  COUNTIF(event.eventType = 'post.commented') - COUNTIF(event.eventType = 'post.comment_deleted') AS commentCount
FROM \`${project}.${analytics}.canonical_events\` AS event
WHERE event.eventType IN ('post.liked', 'post.unliked', 'post.commented', 'post.comment_deleted')
  AND event.occurredAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @outcomeLookbackDays DAY)
  AND JSON_VALUE(event.payload, '$.postId') IS NOT NULL
GROUP BY postId, day;

CREATE TEMP TABLE raw_follows_daily AS
SELECT JSON_VALUE(event.payload, '$.followeeId') AS authorId,
  DATE(event.occurredAt) AS day,
  COUNTIF(event.eventType = 'user.followed') - COUNTIF(event.eventType = 'user.unfollowed') AS newFollowerCount
FROM \`${project}.${analytics}.canonical_events\` AS event
WHERE event.eventType IN ('user.followed', 'user.unfollowed')
  AND event.occurredAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @outcomeLookbackDays DAY)
  AND JSON_VALUE(event.payload, '$.followeeId') IS NOT NULL
GROUP BY authorId, day;

-- A standalone temp table (not a MERGE-scoped CTE) specifically so
-- creator_daily's own MERGE below can also resolve authors for posts that
-- have raw engagement but zero tracked impressions — a CTE defined inside
-- impression_outcomes's MERGE statement would be out of scope there.
CREATE TEMP TABLE post_authors AS
SELECT JSON_VALUE(event.payload, '$.postId') AS postId,
  JSON_VALUE(event.payload, '$.authorId') AS authorId
FROM \`${project}.${analytics}.canonical_events\` AS event
JOIN (
  SELECT postId FROM \`${project}.${analytics}.feed_impressions\`
  WHERE impressionAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @outcomeLookbackDays DAY)
  UNION DISTINCT
  SELECT postId FROM raw_engagement_daily
) AS wanted
  ON JSON_VALUE(event.payload, '$.postId') = wanted.postId
WHERE event.eventType = 'post.created'
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY JSON_VALUE(event.payload, '$.postId')
  ORDER BY event.occurredAt DESC, event.ingestedAt DESC
) = 1;

MERGE \`${project}.${analytics}.impression_outcomes\` AS target
USING (
  WITH impressions AS (
    SELECT * FROM \`${project}.${analytics}.feed_impressions\`
    WHERE impressionAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @outcomeLookbackDays DAY)
  ),
  dwell AS (
    SELECT impression.impressionId,
      MAX(LEAST(60000, SAFE_CAST(JSON_VALUE(event.payload, '$.activeDwellMs') AS INT64))) AS activeDwellMs
    FROM impressions AS impression
    JOIN \`${project}.${analytics}.canonical_events\` AS event
      ON event.eventType = 'post.dwell'
      AND event.actorId = impression.actorId
      AND JSON_VALUE(event.payload, '$.postId') = impression.postId
      AND JSON_VALUE(event.payload, '$.requestId') = impression.requestId
      AND IFNULL(JSON_VALUE(event.payload, '$.sessionId'), '') = IFNULL(impression.sessionId, '')
      AND SAFE_CAST(JSON_VALUE(event.payload, '$.position') AS INT64) = impression.position
      AND event.occurredAt BETWEEN impression.impressionAt
        AND TIMESTAMP_ADD(impression.impressionAt, INTERVAL 24 HOUR)
    GROUP BY impression.impressionId
  ),
  media_progress AS (
    -- playback events report a CUMULATIVE running total per viewing session
    -- (see the observation contract's "send cumulative unique media
    -- milliseconds viewed"), so MAX(...) per impression is the one-session
    -- watch-time contribution — summing every row instead would massively
    -- over-count, since a viewer's own session emits many events at
    -- increasing totals as playback progresses.
    SELECT impression.impressionId,
      MAX(LEAST(1.0, GREATEST(0.0, SAFE_DIVIDE(
        SAFE_CAST(JSON_VALUE(event.payload, '$.mediaPlayedMs') AS FLOAT64),
        SAFE_CAST(JSON_VALUE(event.payload, '$.mediaDurationMs') AS FLOAT64))))) AS mediaCompletionFraction,
      MAX(SAFE_CAST(JSON_VALUE(event.payload, '$.mediaPlayedMs') AS INT64)) AS watchTimeMs
    FROM impressions AS impression
    JOIN \`${project}.${analytics}.canonical_events\` AS event
      ON event.eventType = 'media.progress'
      AND event.actorId = impression.actorId
      AND JSON_VALUE(event.payload, '$.postId') = impression.postId
      AND JSON_VALUE(event.payload, '$.requestId') = impression.requestId
      AND IFNULL(JSON_VALUE(event.payload, '$.sessionId'), '') = IFNULL(impression.sessionId, '')
      AND SAFE_CAST(JSON_VALUE(event.payload, '$.position') AS INT64) = impression.position
      AND SAFE_CAST(JSON_VALUE(event.payload, '$.mediaDurationMs') AS FLOAT64) > 0
      AND event.occurredAt BETWEEN impression.impressionAt
        AND TIMESTAMP_ADD(impression.impressionAt, INTERVAL 24 HOUR)
    GROUP BY impression.impressionId
  ),
  attributed_post_actions AS (
    SELECT impression.impressionId, event.eventId, event.eventType, event.occurredAt, event.ingestedAt
    FROM \`${project}.${analytics}.canonical_events\` AS event
    JOIN impressions AS impression
      ON event.actorId = impression.actorId
      AND JSON_VALUE(event.payload, '$.postId') = impression.postId
      AND event.eventType IN ('post.liked', 'post.unliked', 'post.hidden', 'post.unhidden')
      AND event.occurredAt BETWEEN impression.impressionAt
        AND TIMESTAMP_ADD(impression.impressionAt, INTERVAL 24 HOUR)
    QUALIFY ROW_NUMBER() OVER (PARTITION BY event.eventId ORDER BY impression.impressionAt DESC) = 1
  ),
  action_states AS (
    SELECT impression.impressionId,
      ARRAY_AGG(IF(action.eventType IN ('post.liked', 'post.unliked'), action.eventType, NULL)
        IGNORE NULLS ORDER BY action.occurredAt DESC, action.ingestedAt DESC LIMIT 1)[SAFE_OFFSET(0)] AS likeState,
      ARRAY_AGG(IF(action.eventType IN ('post.hidden', 'post.unhidden'), action.eventType, NULL)
        IGNORE NULLS ORDER BY action.occurredAt DESC, action.ingestedAt DESC LIMIT 1)[SAFE_OFFSET(0)] AS hideState
    FROM impressions AS impression
    LEFT JOIN attributed_post_actions AS action USING (impressionId)
    GROUP BY impression.impressionId
  ),
  attributed_comment_creations AS (
    SELECT impression.impressionId, event.eventId, event.occurredAt,
      JSON_VALUE(event.payload, '$.commentId') AS commentId
    FROM \`${project}.${analytics}.canonical_events\` AS event
    JOIN impressions AS impression
      ON event.actorId = impression.actorId
      AND event.eventType = 'post.commented'
      AND JSON_VALUE(event.payload, '$.postId') = impression.postId
      AND event.occurredAt BETWEEN impression.impressionAt
        AND TIMESTAMP_ADD(impression.impressionAt, INTERVAL 24 HOUR)
    QUALIFY ROW_NUMBER() OVER (PARTITION BY event.eventId ORDER BY impression.impressionAt DESC) = 1
  ),
  comment_states AS (
    SELECT impression.impressionId,
      COUNTIF(comment.eventId IS NOT NULL AND deletion.eventId IS NULL) > 0 AS commented
    FROM impressions AS impression
    LEFT JOIN attributed_comment_creations AS comment USING (impressionId)
    LEFT JOIN \`${project}.${analytics}.canonical_events\` AS deletion
      ON deletion.eventType = 'post.comment_deleted'
      AND JSON_VALUE(deletion.payload, '$.commentId') = comment.commentId
      AND deletion.occurredAt BETWEEN comment.occurredAt
        AND TIMESTAMP_ADD(impression.impressionAt, INTERVAL 24 HOUR)
    GROUP BY impression.impressionId
  ),
  attributed_follow_actions AS (
    SELECT impression.impressionId, event.eventId, event.eventType, event.occurredAt, event.ingestedAt
    FROM \`${project}.${analytics}.canonical_events\` AS event
    JOIN impressions AS impression
      ON event.actorId = impression.actorId
      AND event.eventType IN ('user.followed', 'user.unfollowed')
      AND event.occurredAt BETWEEN impression.impressionAt
        AND TIMESTAMP_ADD(impression.impressionAt, INTERVAL 24 HOUR)
    JOIN post_authors AS author
      ON author.postId = impression.postId
      AND JSON_VALUE(event.payload, '$.followeeId') = author.authorId
    QUALIFY ROW_NUMBER() OVER (PARTITION BY event.eventId ORDER BY impression.impressionAt DESC) = 1
  ),
  follow_states AS (
    SELECT impression.impressionId,
      ARRAY_AGG(action.eventType IGNORE NULLS ORDER BY action.occurredAt DESC,
        action.ingestedAt DESC LIMIT 1)[SAFE_OFFSET(0)] AS followState
    FROM impressions AS impression
    LEFT JOIN attributed_follow_actions AS action USING (impressionId)
    GROUP BY impression.impressionId
  ),
  outcome_base AS (
    SELECT impression.impressionId, impression.actorId, impression.postId, author.authorId,
      impression.requestId, impression.sessionId, impression.position, impression.impressionAt,
      IFNULL(dwell.activeDwellMs, 0) AS activeDwellMs,
      IFNULL(media.mediaCompletionFraction, 0.0) AS mediaCompletionFraction,
      IFNULL(media.watchTimeMs, 0) AS watchTimeMs,
      IFNULL(actions.likeState = 'post.liked', FALSE) AS liked,
      IFNULL(comments.commented, FALSE) AS commented,
      IFNULL(actions.hideState = 'post.hidden', FALSE) AS hidden,
      IFNULL(follows.followState = 'user.followed', FALSE) AS attributedFollow,
      TIMESTAMP_ADD(impression.impressionAt, INTERVAL 48 HOUR) AS labelMaturedAt
    FROM impressions AS impression
    LEFT JOIN post_authors AS author USING (postId)
    LEFT JOIN dwell USING (impressionId)
    LEFT JOIN media_progress AS media USING (impressionId)
    LEFT JOIN action_states AS actions USING (impressionId)
    LEFT JOIN comment_states AS comments USING (impressionId)
    LEFT JOIN follow_states AS follows USING (impressionId)
  )
  SELECT outcome_base.*,
    (liked OR commented OR activeDwellMs >= 10000 OR mediaCompletionFraction >= 0.5) AS meaningful,
    CURRENT_TIMESTAMP() < labelMaturedAt AS provisional
  FROM outcome_base
) AS source
ON target.impressionId = source.impressionId
WHEN MATCHED THEN UPDATE SET authorId = source.authorId, activeDwellMs = source.activeDwellMs,
  mediaCompletionFraction = source.mediaCompletionFraction, watchTimeMs = source.watchTimeMs,
  liked = source.liked, commented = source.commented, hidden = source.hidden,
  attributedFollow = source.attributedFollow, meaningful = source.meaningful,
  labelMaturedAt = source.labelMaturedAt, provisional = source.provisional,
  computedAt = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (impressionId, actorId, postId, authorId, requestId, sessionId,
  position, impressionAt, activeDwellMs, mediaCompletionFraction, watchTimeMs, liked, commented, hidden, attributedFollow,
  meaningful, labelMaturedAt, provisional, computedAt)
VALUES (source.impressionId, source.actorId, source.postId, source.authorId, source.requestId,
  source.sessionId, source.position, source.impressionAt, source.activeDwellMs, source.mediaCompletionFraction,
  source.watchTimeMs, source.liked,
  source.commented, source.hidden, source.attributedFollow, source.meaningful,
  source.labelMaturedAt, source.provisional, CURRENT_TIMESTAMP());

CREATE TABLE IF NOT EXISTS \`${project}.${analytics}.post_daily\` (
  postId STRING NOT NULL, day DATE NOT NULL,
  qualifiedReach INT64 NOT NULL, qualifiedImpressions INT64 NOT NULL,
  meaningfulCount INT64 NOT NULL, hideCount INT64 NOT NULL,
  medianDwellMs INT64, watchTimeMs INT64 NOT NULL, likeCount INT64 NOT NULL, commentCount INT64 NOT NULL,
  asOf TIMESTAMP NOT NULL, provisional BOOL NOT NULL,
  materializedAt TIMESTAMP NOT NULL
)
PARTITION BY day
CLUSTER BY postId;

ALTER TABLE \`${project}.${analytics}.post_daily\`
ADD COLUMN IF NOT EXISTS watchTimeMs INT64,
ADD COLUMN IF NOT EXISTS likeCount INT64,
ADD COLUMN IF NOT EXISTS commentCount INT64;

CREATE TABLE IF NOT EXISTS \`${project}.${analytics}.creator_daily\` (
  authorId STRING NOT NULL, day DATE NOT NULL,
  qualifiedReach INT64 NOT NULL, qualifiedImpressions INT64 NOT NULL,
  meaningfulCount INT64 NOT NULL, hideCount INT64 NOT NULL,
  distinctPosts INT64 NOT NULL,
  watchTimeMs INT64 NOT NULL, likeCount INT64 NOT NULL, commentCount INT64 NOT NULL, newFollowerCount INT64 NOT NULL,
  asOf TIMESTAMP NOT NULL, provisional BOOL NOT NULL,
  materializedAt TIMESTAMP NOT NULL
)
PARTITION BY day
CLUSTER BY authorId;

ALTER TABLE \`${project}.${analytics}.creator_daily\`
ADD COLUMN IF NOT EXISTS watchTimeMs INT64,
ADD COLUMN IF NOT EXISTS likeCount INT64,
ADD COLUMN IF NOT EXISTS commentCount INT64,
ADD COLUMN IF NOT EXISTS newFollowerCount INT64;

-- raw_engagement_daily/raw_follows_daily are computed earlier (above
-- post_authors, which needs raw_engagement_daily's postId set too).

MERGE \`${project}.${analytics}.post_daily\` AS target
USING (
  WITH outcome_agg AS (
    SELECT postId, DATE(impressionAt) AS day,
      COUNT(DISTINCT actorId) AS qualifiedReach,
      COUNT(*) AS qualifiedImpressions,
      COUNTIF(meaningful) AS meaningfulCount,
      COUNTIF(hidden) AS hideCount,
      APPROX_QUANTILES(activeDwellMs, 100)[OFFSET(50)] AS medianDwellMs,
      SUM(watchTimeMs) AS watchTimeMs,
      MAX(labelMaturedAt) AS asOf,
      LOGICAL_OR(provisional) AS provisional
    FROM \`${project}.${analytics}.impression_outcomes\`
    WHERE impressionAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @outcomeLookbackDays DAY)
    GROUP BY postId, day
  )
  SELECT COALESCE(outcome_agg.postId, raw_engagement_daily.postId) AS postId,
    COALESCE(outcome_agg.day, raw_engagement_daily.day) AS day,
    IFNULL(outcome_agg.qualifiedReach, 0) AS qualifiedReach,
    IFNULL(outcome_agg.qualifiedImpressions, 0) AS qualifiedImpressions,
    IFNULL(outcome_agg.meaningfulCount, 0) AS meaningfulCount,
    IFNULL(outcome_agg.hideCount, 0) AS hideCount,
    outcome_agg.medianDwellMs,
    IFNULL(outcome_agg.watchTimeMs, 0) AS watchTimeMs,
    IFNULL(raw_engagement_daily.likeCount, 0) AS likeCount,
    IFNULL(raw_engagement_daily.commentCount, 0) AS commentCount,
    IFNULL(outcome_agg.asOf, TIMESTAMP(DATETIME(COALESCE(outcome_agg.day, raw_engagement_daily.day)))) AS asOf,
    IFNULL(outcome_agg.provisional, FALSE) AS provisional
  FROM outcome_agg
  FULL OUTER JOIN raw_engagement_daily USING (postId, day)
) AS source
ON target.postId = source.postId AND target.day = source.day
WHEN MATCHED THEN UPDATE SET qualifiedReach = source.qualifiedReach,
  qualifiedImpressions = source.qualifiedImpressions, meaningfulCount = source.meaningfulCount,
  hideCount = source.hideCount, medianDwellMs = source.medianDwellMs,
  watchTimeMs = source.watchTimeMs, likeCount = source.likeCount, commentCount = source.commentCount,
  asOf = source.asOf, provisional = source.provisional, materializedAt = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (postId, day, qualifiedReach, qualifiedImpressions,
  meaningfulCount, hideCount, medianDwellMs, watchTimeMs, likeCount, commentCount, asOf, provisional, materializedAt)
VALUES (source.postId, source.day, source.qualifiedReach, source.qualifiedImpressions,
  source.meaningfulCount, source.hideCount, source.medianDwellMs,
  source.watchTimeMs, source.likeCount, source.commentCount, source.asOf,
  source.provisional, CURRENT_TIMESTAMP());

MERGE \`${project}.${analytics}.creator_daily\` AS target
USING (
  WITH outcome_agg AS (
    SELECT authorId, DATE(impressionAt) AS day,
      COUNT(DISTINCT actorId) AS qualifiedReach,
      COUNT(*) AS qualifiedImpressions,
      COUNTIF(meaningful) AS meaningfulCount,
      COUNTIF(hidden) AS hideCount,
      COUNT(DISTINCT postId) AS distinctPosts,
      SUM(watchTimeMs) AS watchTimeMs,
      MAX(labelMaturedAt) AS asOf,
      LOGICAL_OR(provisional) AS provisional
    FROM \`${project}.${analytics}.impression_outcomes\`
    WHERE impressionAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @outcomeLookbackDays DAY)
      AND authorId IS NOT NULL
    GROUP BY authorId, day
  ),
  post_engagement_by_author AS (
    SELECT post_authors.authorId, raw_engagement_daily.day,
      SUM(raw_engagement_daily.likeCount) AS likeCount,
      SUM(raw_engagement_daily.commentCount) AS commentCount
    FROM raw_engagement_daily
    JOIN \`${project}.${analytics}.canonical_events\` AS created
      ON created.eventType = 'post.created'
      AND JSON_VALUE(created.payload, '$.postId') = raw_engagement_daily.postId
    JOIN post_authors ON post_authors.postId = raw_engagement_daily.postId
    GROUP BY authorId, day
  )
  SELECT COALESCE(outcome_agg.authorId, post_engagement_by_author.authorId, raw_follows_daily.authorId) AS authorId,
    COALESCE(outcome_agg.day, post_engagement_by_author.day, raw_follows_daily.day) AS day,
    IFNULL(outcome_agg.qualifiedReach, 0) AS qualifiedReach,
    IFNULL(outcome_agg.qualifiedImpressions, 0) AS qualifiedImpressions,
    IFNULL(outcome_agg.meaningfulCount, 0) AS meaningfulCount,
    IFNULL(outcome_agg.hideCount, 0) AS hideCount,
    IFNULL(outcome_agg.distinctPosts, 0) AS distinctPosts,
    IFNULL(outcome_agg.watchTimeMs, 0) AS watchTimeMs,
    IFNULL(post_engagement_by_author.likeCount, 0) AS likeCount,
    IFNULL(post_engagement_by_author.commentCount, 0) AS commentCount,
    IFNULL(raw_follows_daily.newFollowerCount, 0) AS newFollowerCount,
    IFNULL(outcome_agg.asOf,
      TIMESTAMP(DATETIME(COALESCE(outcome_agg.day, post_engagement_by_author.day, raw_follows_daily.day)))) AS asOf,
    IFNULL(outcome_agg.provisional, FALSE) AS provisional
  FROM outcome_agg
  FULL OUTER JOIN post_engagement_by_author USING (authorId, day)
  FULL OUTER JOIN raw_follows_daily USING (authorId, day)
) AS source
ON target.authorId = source.authorId AND target.day = source.day
WHEN MATCHED THEN UPDATE SET qualifiedReach = source.qualifiedReach,
  qualifiedImpressions = source.qualifiedImpressions, meaningfulCount = source.meaningfulCount,
  hideCount = source.hideCount, distinctPosts = source.distinctPosts,
  watchTimeMs = source.watchTimeMs, likeCount = source.likeCount,
  commentCount = source.commentCount, newFollowerCount = source.newFollowerCount,
  asOf = source.asOf, provisional = source.provisional, materializedAt = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (authorId, day, qualifiedReach, qualifiedImpressions,
  meaningfulCount, hideCount, distinctPosts, watchTimeMs, likeCount, commentCount, newFollowerCount,
  asOf, provisional, materializedAt)
VALUES (source.authorId, source.day, source.qualifiedReach, source.qualifiedImpressions,
  source.meaningfulCount, source.hideCount, source.distinctPosts,
  source.watchTimeMs, source.likeCount, source.commentCount, source.newFollowerCount, source.asOf,
  source.provisional, CURRENT_TIMESTAMP());
`;
}
