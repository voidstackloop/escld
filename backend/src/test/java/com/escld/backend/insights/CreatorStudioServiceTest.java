package com.escld.backend.insights;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

import static java.util.Map.entry;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import software.amazon.awssdk.services.dynamodb.model.AttributeValue;

import com.escld.backend.dto.InsightsHistoryResponse;
import com.escld.backend.exceptions.InsightsUnavailableException;

@ExtendWith(MockitoExtension.class)
class CreatorStudioServiceTest {

    @Mock
    private InsightsStore insightsStore;

    private CreatorStudioService service;

    private final UUID userId = UUID.randomUUID();

    private static Map<String, AttributeValue> item(LocalDate day, long watchTimeMs, long newFollowerCount, int distinctPosts) {
        return Map.ofEntries(
                entry("sk", AttributeValue.fromS("DATE#" + day)),
                entry("qualifiedReach", AttributeValue.fromN("100")),
                entry("qualifiedImpressions", AttributeValue.fromN("150")),
                entry("meaningfulCount", AttributeValue.fromN("40")),
                entry("hideCount", AttributeValue.fromN("1")),
                entry("distinctPosts", AttributeValue.fromN(String.valueOf(distinctPosts))),
                entry("watchTimeMs", AttributeValue.fromN(String.valueOf(watchTimeMs))),
                entry("likeCount", AttributeValue.fromN("20")),
                entry("commentCount", AttributeValue.fromN("5")),
                entry("newFollowerCount", AttributeValue.fromN(String.valueOf(newFollowerCount))),
                entry("asOf", AttributeValue.fromS(day.plusDays(2) + "T00:00:00Z")),
                entry("provisional", AttributeValue.fromBool(false)));
    }

    @Test
    void throws503WhenNoInsightsHaveLandedForThisCreatorYet() {
        service = new CreatorStudioService(insightsStore);
        when(insightsStore.queryCreatorRange(any(), any(), any())).thenReturn(List.of());

        assertThatThrownBy(() -> service.getInsights(userId, null, null))
                .isInstanceOf(InsightsUnavailableException.class);
    }

    @Test
    void assemblesAccountWideDailyTrendsIncludingCreatorOnlyFields() {
        service = new CreatorStudioService(insightsStore);
        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        LocalDate from = today.minusDays(2);
        when(insightsStore.queryCreatorRange(userId, from, today))
                .thenReturn(List.of(item(from, 3_600_000, 4, 6)));

        InsightsHistoryResponse response = service.getInsights(userId, from, today);

        InsightsHistoryResponse.DailyPoint firstDay = response.points().get(0);
        assertThat(firstDay.watchTimeSeconds()).isEqualTo(3600L);
        assertThat(firstDay.newFollowerCount()).isEqualTo(4L);
        assertThat(firstDay.distinctPosts()).isEqualTo(6L);
    }

    @Test
    void rejectsAnInvertedOrOverlongDateRangeBeforeQueryingTheStore() {
        service = new CreatorStudioService(insightsStore);
        LocalDate today = LocalDate.now(ZoneOffset.UTC);

        assertThatThrownBy(() -> service.getInsights(userId, today, today.minusDays(1)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.getInsights(userId, today.minusDays(200), today))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
