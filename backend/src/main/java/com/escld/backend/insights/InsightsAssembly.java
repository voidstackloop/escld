package com.escld.backend.insights;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

import software.amazon.awssdk.services.dynamodb.model.AttributeValue;

import com.escld.backend.dto.InsightsHistoryResponse;
import com.escld.backend.dto.InsightsHistoryResponse.DailyPoint;

/**
 * Turns a list of {@link InsightsStore} DynamoDB items into the
 * {@link InsightsHistoryResponse} contract both {@link PostInsightsService}
 * and the account-wide Creator Studio view share — see
 * docs/DATA_ANALYSIS_AND_FEED_DESIGN.md §7.2.
 */
final class InsightsAssembly {

    /** post_daily/creator_daily rows carry a 48h label-maturity window (see
     * bq-sink's canonicalizer.ts) — a day inside this window with no landed
     * item might just still be materializing, not genuinely zero. */
    private static final int MATURITY_DAYS = 2;

    private InsightsAssembly() {
    }

    static InsightsHistoryResponse assemblePostSeries(
            LocalDate from, LocalDate to, List<Map<String, AttributeValue>> items) {
        return assemble(from, to, items, InsightsAssembly::postPoint, false);
    }

    static InsightsHistoryResponse assembleCreatorSeries(
            LocalDate from, LocalDate to, List<Map<String, AttributeValue>> items) {
        return assemble(from, to, items, InsightsAssembly::creatorPoint, true);
    }

    private interface PointMapper {
        DailyPoint map(Map<String, AttributeValue> item);
    }

    private static InsightsHistoryResponse assemble(
            LocalDate from, LocalDate to,
            List<Map<String, AttributeValue>> items,
            PointMapper pointMapper,
            boolean creatorSeries) {
        Map<LocalDate, DailyPoint> byDay = items.stream()
                .map(pointMapper::map)
                .collect(Collectors.toMap(DailyPoint::day, point -> point, (a, b) -> a));

        LocalDate now = LocalDate.now(java.time.ZoneOffset.UTC);
        List<DailyPoint> points = new ArrayList<>();
        boolean allComplete = true;
        for (LocalDate day = from; day.isBefore(to); day = day.plusDays(1)) {
            DailyPoint point = byDay.get(day);
            if (point == null) {
                boolean pastMaturity = day.plusDays(MATURITY_DAYS).isBefore(now);
                if (pastMaturity) {
                    point = zero(day, creatorSeries);
                } else {
                    point = unavailable(day);
                    allComplete = false;
                }
            } else if (!"COMPLETE".equals(point.dataStatus())) {
                allComplete = false;
            }
            points.add(point);
        }

        String asOf = items.stream()
                .map(item -> InsightsStore.string(item, "asOf"))
                .filter(Objects::nonNull)
                .max(String::compareTo)
                .orElse(Instant.now().toString());

        return new InsightsHistoryResponse(from, to, "day", points, allComplete ? "COMPLETE" : "PROVISIONAL", asOf);
    }

    private static DailyPoint postPoint(Map<String, AttributeValue> item) {
        boolean provisional = Boolean.TRUE.equals(InsightsStore.booleanValue(item, "provisional"));
        return new DailyPoint(
                InsightsStore.day(item),
                InsightsStore.longValue(item, "qualifiedReach"),
                InsightsStore.longValue(item, "qualifiedImpressions"),
                InsightsStore.longValue(item, "meaningfulCount"),
                InsightsStore.longValue(item, "hideCount"),
                watchTimeSeconds(item),
                InsightsStore.longValue(item, "likeCount"),
                InsightsStore.longValue(item, "commentCount"),
                null,
                null,
                provisional ? "PROVISIONAL" : "COMPLETE");
    }

    private static DailyPoint creatorPoint(Map<String, AttributeValue> item) {
        boolean provisional = Boolean.TRUE.equals(InsightsStore.booleanValue(item, "provisional"));
        return new DailyPoint(
                InsightsStore.day(item),
                InsightsStore.longValue(item, "qualifiedReach"),
                InsightsStore.longValue(item, "qualifiedImpressions"),
                InsightsStore.longValue(item, "meaningfulCount"),
                InsightsStore.longValue(item, "hideCount"),
                watchTimeSeconds(item),
                InsightsStore.longValue(item, "likeCount"),
                InsightsStore.longValue(item, "commentCount"),
                InsightsStore.longValue(item, "distinctPosts"),
                InsightsStore.longValue(item, "newFollowerCount"),
                provisional ? "PROVISIONAL" : "COMPLETE");
    }

    private static Long watchTimeSeconds(Map<String, AttributeValue> item) {
        Long watchTimeMs = InsightsStore.longValue(item, "watchTimeMs");
        return watchTimeMs == null ? null : watchTimeMs / 1000;
    }

    /** distinctPosts/newFollowerCount are creator-series-only (see
     * InsightsHistoryResponse's own doc comment) — a gap-filled zero day on
     * a per-post series must leave them null, not a misleading 0. */
    private static DailyPoint zero(LocalDate day, boolean creatorSeries) {
        Long creatorZero = creatorSeries ? 0L : null;
        return new DailyPoint(day, 0L, 0L, 0L, 0L, 0L, 0L, 0L, creatorZero, creatorZero, "COMPLETE");
    }

    private static DailyPoint unavailable(LocalDate day) {
        return new DailyPoint(day, null, null, null, null, null, null, null, null, null, "UNAVAILABLE");
    }
}
