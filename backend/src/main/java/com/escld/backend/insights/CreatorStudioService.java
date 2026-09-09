package com.escld.backend.insights;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Component;

import software.amazon.awssdk.services.dynamodb.model.AttributeValue;

import com.escld.backend.dto.InsightsHistoryResponse;
import com.escld.backend.exceptions.InsightsUnavailableException;

/**
 * Account-wide "Creator Studio" analytics — the historical, time-series
 * half of docs/DATA_ANALYSIS_AND_FEED_DESIGN.md §7.2's
 * {@code GET /api/v1/users/me/insights}. Deliberately time-series only:
 * "as of now" totals (current like/comment/follower counts) already exist
 * cheaply via the plain profile/post read paths this app has always had —
 * duplicating them here would just be a second, staler copy of numbers
 * Postgres already answers live. This service exists for the one thing
 * those reads can't answer: trends over a date range, which only the
 * warehouse's daily aggregation (bq-sink's post_daily/creator_daily,
 * materialized into {@link InsightsStore} — see its own doc comment)
 * actually has.
 */
@Component
public class CreatorStudioService {

    private final InsightsStore insightsStore;

    public CreatorStudioService(InsightsStore insightsStore) {
        this.insightsStore = insightsStore;
    }

    /** Same contract as {@link PostInsightsService#getHistory}: UTC,
     * inclusive from, exclusive to, default 7d, max 90d, 503 when the
     * exporter has landed nothing at all for this creator yet. */
    public InsightsHistoryResponse getInsights(UUID userId, LocalDate from, LocalDate to) {
        LocalDate now = LocalDate.now(java.time.ZoneOffset.UTC);
        LocalDate resolvedTo = to == null ? now : to;
        LocalDate resolvedFrom = from == null ? resolvedTo.minusDays(7) : from;
        if (!resolvedFrom.isBefore(resolvedTo) || resolvedFrom.plusDays(90).isBefore(resolvedTo)) {
            throw new IllegalArgumentException("Invalid date window: from must precede to within 90 days");
        }

        List<Map<String, AttributeValue>> items = insightsStore.queryCreatorRange(userId, resolvedFrom, resolvedTo);
        if (items.isEmpty()) {
            throw new InsightsUnavailableException(
                    "No materialized insights landed yet for creator " + userId);
        }

        return InsightsAssembly.assembleCreatorSeries(resolvedFrom, resolvedTo, items);
    }
}
