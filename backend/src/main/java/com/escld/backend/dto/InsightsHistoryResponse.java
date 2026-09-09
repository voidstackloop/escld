package com.escld.backend.dto;

import java.time.LocalDate;
import java.util.List;

/** Owner-only historical aggregates with explicit unavailable-data handling.
 * Zero means measured zero; unavailable or incomplete windows return nullable
 * metrics with dataStatus + asOf. Product cohorts and raw observations are
 * never creator APIs. Shared, byte-for-byte, between per-post history
 * (GET /posts/{id}/insights/history) and the account-wide Creator Studio
 * view (GET /users/me/insights) — see docs/DATA_ANALYSIS_AND_FEED_DESIGN.md
 * §7.2, which specs both endpoints against "the same dates". */
public record InsightsHistoryResponse(
        LocalDate from,
        LocalDate to,
        String granularity,
        List<DailyPoint> points,
        String dataStatus,
        String asOf) {
    /** distinctPosts/newFollowerCount are creator-series-only and null on a
     * per-post series (a single post has no "how many posts" or "how many
     * new followers" of its own) — every other field applies to both. */
    public record DailyPoint(
            LocalDate day,
            Long qualifiedReach,
            Long qualifiedImpressions,
            Long meaningfulCount,
            Long hideCount,
            Long watchTimeSeconds,
            Long likeCount,
            Long commentCount,
            Long distinctPosts,
            Long newFollowerCount,
            String dataStatus) {}
}
