package com.escld.backend.dto;

import java.time.Instant;
import java.util.UUID;

import com.escld.backend.post.LiveStatus;

/**
 * Author-only performance snapshot for a single post — see PostInsightsService.
 * The live-stream fields are null on every non-LIVE post; currentViewerCount
 * is null unless the stream is still LIVE right now (once it ends, only
 * peakViewerCount remains meaningful — see Post.peakViewerCount's own doc).
 */
public record PostInsightsResponse(
        UUID postId,
        int likeCount,
        int commentCount,
        double trendingScore,
        boolean trending,
        LiveStatus liveStatus,
        Instant liveStartedAt,
        Instant liveEndedAt,
        Long durationSeconds,
        Integer peakViewerCount,
        Integer currentViewerCount) {
}
