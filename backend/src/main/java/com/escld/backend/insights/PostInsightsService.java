package com.escld.backend.insights;

import java.time.Duration;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Component;

import software.amazon.awssdk.services.dynamodb.model.AttributeValue;

import com.escld.backend.dto.InsightsHistoryResponse;
import com.escld.backend.dto.PostInsightsResponse;
import com.escld.backend.entities.Post;
import com.escld.backend.exceptions.InsightsUnavailableException;
import com.escld.backend.exceptions.NotPostOwnerException;
import com.escld.backend.live.LiveViewerPresenceService;
import com.escld.backend.post.LiveStatus;
import com.escld.backend.services.PostService;
import com.escld.backend.trending.TrendingScoreClient;

/**
 * A performance snapshot for one post, visible only to its own author — the
 * "creator-facing insights" enrichment. The at-a-glance snapshot
 * ({@link #getInsights}) is deliberately assembled from data this app
 * already computes elsewhere (Postgres counters, TrendingScoreClient,
 * LiveViewerPresenceService), not the warehouse: querying BigQuery live on
 * every insights view was never justified just to show one post's current
 * standing. The historical series ({@link #getHistory}) is different —
 * "how did this post trend over the last N days" genuinely needs the
 * warehouse's own daily aggregation, which is why it reads from
 * {@link InsightsStore} (bq-sink's materialized, DynamoDB-landed export of
 * BigQuery's post_daily table — see docs/DATA_ANALYSIS_AND_FEED_DESIGN.md
 * §7.2) rather than a live cross-cloud query.
 */
@Component
public class PostInsightsService {

    private final PostService postService;
    private final TrendingScoreClient trendingScoreClient;
    private final LiveViewerPresenceService liveViewerPresenceService;
    private final InsightsStore insightsStore;

    public PostInsightsService(
            PostService postService,
            TrendingScoreClient trendingScoreClient,
            LiveViewerPresenceService liveViewerPresenceService,
            InsightsStore insightsStore) {
        this.postService = postService;
        this.trendingScoreClient = trendingScoreClient;
        this.liveViewerPresenceService = liveViewerPresenceService;
        this.insightsStore = insightsStore;
    }

    public PostInsightsResponse getInsights(UUID postId, UUID requesterId) {
        Post post = postService.getById(postId);
        if (!post.getUserId().equals(requesterId)) {
            throw new NotPostOwnerException();
        }

        double trendingScore = trendingScoreClient.getScores(List.of(postId)).getOrDefault(postId, 0.0);
        boolean trending = trendingScore > TrendingScoreClient.TRENDING_DISPLAY_THRESHOLD;

        Long durationSeconds = null;
        if (post.getLiveStartedAt() != null && post.getLiveEndedAt() != null) {
            durationSeconds = Duration.between(post.getLiveStartedAt(), post.getLiveEndedAt()).getSeconds();
        }

        // Only meaningful while the stream is actually live — once it ends,
        // presence state is cleared (see LiveStreamServiceImpl.end) and
        // peakViewerCount, persisted separately, is the number that matters.
        Integer currentViewerCount = post.getLiveStatus() == LiveStatus.LIVE
                ? liveViewerPresenceService.getViewerCount(postId)
                : null;

        return new PostInsightsResponse(
                post.getId(),
                post.getLikeCount(),
                post.getCommentCount(),
                trendingScore,
                trending,
                post.getLiveStatus(),
                post.getLiveStartedAt(),
                post.getLiveEndedAt(),
                durationSeconds,
                post.getPeakViewerCount(),
                currentViewerCount);
    }

    /** Historical aggregates (UTC, inclusive from, exclusive to, default 7d,
     * max 90d). Reads {@link InsightsStore}'s POST# series — bq-sink's
     * hourly export of BigQuery's post_daily table. A day with no landed
     * item is reported as either a genuine measured zero (once comfortably
     * past the 48h label-maturity window post_daily's own rows use) or
     * still-materializing/unavailable (within that window) — never silently
     * assumed to be zero while data could still be in flight. If the store
     * has landed literally nothing for this post across the whole requested
     * range, this throws 503 rather than reporting an all-zero series with
     * no real signal the export pipeline has ever run for it. */
    public InsightsHistoryResponse getHistory(UUID postId, UUID requesterId, LocalDate from, LocalDate to) {
        Post post = postService.getById(postId);
        if (!post.getUserId().equals(requesterId)) {
            throw new NotPostOwnerException();
        }
        LocalDate now = LocalDate.now(java.time.ZoneOffset.UTC);
        LocalDate resolvedTo = to == null ? now : to;
        LocalDate resolvedFrom = from == null ? resolvedTo.minusDays(7) : from;
        if (!resolvedFrom.isBefore(resolvedTo) || resolvedFrom.plusDays(90).isBefore(resolvedTo)) {
            throw new IllegalArgumentException("Invalid date window: from must precede to within 90 days");
        }

        List<Map<String, AttributeValue>> items = insightsStore.queryPostRange(postId, resolvedFrom, resolvedTo);
        if (items.isEmpty()) {
            throw new InsightsUnavailableException(
                    "No materialized insights landed yet for post " + postId);
        }

        return InsightsAssembly.assemblePostSeries(resolvedFrom, resolvedTo, items);
    }
}
