package com.escld.backend.trending;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Component;

import com.escld.backend.metrics.EmfMetrics;

import io.lettuce.core.api.StatefulRedisConnection;
import lombok.extern.slf4j.Slf4j;

/**
 * Reads the live trending score `analytics` computes into Redis — a single
 * shared ElastiCache cluster (see CacheStack), not a private store this
 * reaches into. `trending:posts` is a sorted set, one entry per post,
 * ZINCRBY'd on every post_created/post_liked/post_commented event and
 * periodically decayed (see analytics/src/trending.ts's TrendingStore).
 * Treat that file as the authoritative schema for this key — don't change
 * its shape here without updating that side too.
 */
@Slf4j
@Component
public class TrendingScoreClient {

    private static final String TRENDING_POSTS_KEY = "trending:posts";

    /** Written by analytics/src/events.ts alongside trending:posts — same
     * sorted-set-per-entity-type schema, decayed independently. Real,
     * already-computed signal; getHashtagScores is the first reader of it
     * anywhere in this backend. */
    private static final String TRENDING_HASHTAGS_KEY = "trending:hashtags";

    /** Cutoff for treating a post as "genuinely trending" (the `trending`
     * flag on PostResponse, and PostInsightsService's own `trending` field)
     * — every post gets some baseline score just from its own post_created
     * event (analytics' WEIGHT_POST_CREATED, default 1 — see
     * analytics/src/config.ts), so a raw-score-present check would badge
     * nearly every fresh post as trending. Requiring the score to exceed
     * that baseline means genuine additional engagement (a like or comment)
     * actually happened. This does assume analytics' default weights
     * haven't been reconfigured — a real, accepted coupling to that
     * service's config, same as this whole feature's dependency on its
     * Redis key schema. Public (not just FeedServiceImpl's own constant)
     * because PostInsightsService needs the identical cutoff outside the
     * feed-ranking path. */
    public static final double TRENDING_DISPLAY_THRESHOLD = 1.0;

    private final StatefulRedisConnection<String, String> connection;
    private final EmfMetrics emfMetrics;

    public TrendingScoreClient(StatefulRedisConnection<String, String> trendingRedisConnection, EmfMetrics emfMetrics) {
        this.connection = trendingRedisConnection;
        this.emfMetrics = emfMetrics;
    }

    /**
     * Batched lookup — one ZMSCORE round trip for every candidate rather than
     * one per post. Best-effort: any Redis failure (or the connection simply
     * being unavailable) returns an empty map rather than propagating, so a
     * hiccup here degrades feed ranking back to exactly its pre-trending
     * behavior instead of failing the request — same "must never break the
     * thing it's instrumenting" reasoning already used by EmfMetrics and the
     * SQS/Redis event publishers elsewhere in this codebase. A post that
     * never trended, or has since decayed out of the sorted set, is simply
     * absent from the returned map — not an error.
     *
     * Emits trending_score_lookup_total{result} either way — this is the one
     * signal that tells us whether this feature is actually reaching Redis in
     * production at all, since a silent fallback to Map.of() is otherwise
     * indistinguishable from "nothing is trending right now."
     */
    public Map<UUID, Double> getScores(List<UUID> postIds) {
        if (postIds.isEmpty()) {
            return Map.of();
        }
        try {
            String[] members = postIds.stream().map(UUID::toString).toArray(String[]::new);
            List<Double> scores = connection.sync().zmscore(TRENDING_POSTS_KEY, members);

            Map<UUID, Double> result = new HashMap<>();
            for (int i = 0; i < postIds.size(); i++) {
                Double score = scores.get(i);
                if (score != null) {
                    result.put(postIds.get(i), score);
                }
            }
            emfMetrics.increment("trending_score_lookup_total", Map.of("result", "success", "entity_type", "posts"));
            return result;
        } catch (Exception e) {
            log.warn("Failed to fetch trending scores from Redis", e);
            emfMetrics.increment("trending_score_lookup_total", Map.of("result", "failure", "entity_type", "posts"));
            return Map.of();
        }
    }

    /**
     * Same batched-ZMSCORE-with-catch-empty-map shape as getScores, against
     * the sibling trending:hashtags sorted set — a separate method rather
     * than a new @Component, since both keys live in the one shared Redis
     * connection this class already owns (see TrendingConfig).
     */
    public Map<String, Double> getHashtagScores(List<String> tags) {
        if (tags.isEmpty()) {
            return Map.of();
        }
        try {
            String[] members = tags.toArray(new String[0]);
            List<Double> scores = connection.sync().zmscore(TRENDING_HASHTAGS_KEY, members);

            Map<String, Double> result = new HashMap<>();
            for (int i = 0; i < tags.size(); i++) {
                Double score = scores.get(i);
                if (score != null) {
                    result.put(tags.get(i), score);
                }
            }
            emfMetrics.increment("trending_score_lookup_total", Map.of("result", "success", "entity_type", "hashtags"));
            return result;
        } catch (Exception e) {
            log.warn("Failed to fetch trending hashtag scores from Redis", e);
            emfMetrics.increment("trending_score_lookup_total", Map.of("result", "failure", "entity_type", "hashtags"));
            return Map.of();
        }
    }
}
