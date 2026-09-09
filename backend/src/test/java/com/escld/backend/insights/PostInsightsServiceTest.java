package com.escld.backend.insights;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

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

@ExtendWith(MockitoExtension.class)
class PostInsightsServiceTest {

    @Mock
    private PostService postService;
    @Mock
    private TrendingScoreClient trendingScoreClient;
    @Mock
    private LiveViewerPresenceService liveViewerPresenceService;
    @Mock
    private InsightsStore insightsStore;

    private PostInsightsService service;

    private final UUID authorId = UUID.randomUUID();
    private final UUID postId = UUID.randomUUID();

    private PostInsightsService service() {
        return new PostInsightsService(postService, trendingScoreClient, liveViewerPresenceService, insightsStore);
    }

    private static Map<String, AttributeValue> item(LocalDate day, long likeCount, long watchTimeMs, boolean provisional) {
        return Map.of(
                "sk", AttributeValue.fromS("DATE#" + day),
                "qualifiedReach", AttributeValue.fromN("10"),
                "qualifiedImpressions", AttributeValue.fromN("15"),
                "meaningfulCount", AttributeValue.fromN("4"),
                "hideCount", AttributeValue.fromN("0"),
                "watchTimeMs", AttributeValue.fromN(String.valueOf(watchTimeMs)),
                "likeCount", AttributeValue.fromN(String.valueOf(likeCount)),
                "commentCount", AttributeValue.fromN("1"),
                "asOf", AttributeValue.fromS(day.plusDays(2) + "T00:00:00Z"),
                "provisional", AttributeValue.fromBool(provisional));
    }

    @Test
    void returnsCountsAndTrendingScoreForAPlainPost() {
        service = service();
        Post post = Post.builder().id(postId).userId(authorId).likeCount(5).commentCount(2).build();
        when(postService.getById(postId)).thenReturn(post);
        when(trendingScoreClient.getScores(any())).thenReturn(Map.of(postId, 3.5));

        PostInsightsResponse insights = service.getInsights(postId, authorId);

        assertThat(insights.likeCount()).isEqualTo(5);
        assertThat(insights.commentCount()).isEqualTo(2);
        assertThat(insights.trendingScore()).isEqualTo(3.5);
        assertThat(insights.trending()).isTrue();
        assertThat(insights.liveStatus()).isNull();
        assertThat(insights.currentViewerCount()).isNull();
    }

    @Test
    void refusesToReturnInsightsForSomeoneElsesPost() {
        service = service();
        Post post = Post.builder().id(postId).userId(authorId).build();
        when(postService.getById(postId)).thenReturn(post);

        assertThatThrownBy(() -> service.getInsights(postId, UUID.randomUUID()))
                .isInstanceOf(NotPostOwnerException.class);
    }

    @Test
    void reportsALiveCurrentViewerCountOnlyWhileStillLive() {
        service = service();
        Post post = Post.builder().id(postId).userId(authorId).liveStatus(LiveStatus.LIVE).build();
        when(postService.getById(postId)).thenReturn(post);
        when(trendingScoreClient.getScores(any())).thenReturn(Map.of());
        when(liveViewerPresenceService.getViewerCount(postId)).thenReturn(12);

        PostInsightsResponse insights = service.getInsights(postId, authorId);

        assertThat(insights.currentViewerCount()).isEqualTo(12);
    }

    @Test
    void computesDurationAndReportsPeakViewersForAnEndedStreamWithoutQueryingLiveViewerCount() {
        service = service();
        Instant startedAt = Instant.parse("2026-01-01T00:00:00Z");
        Instant endedAt = Instant.parse("2026-01-01T01:05:00Z");
        Post post = Post.builder()
                .id(postId)
                .userId(authorId)
                .liveStatus(LiveStatus.ENDED)
                .liveStartedAt(startedAt)
                .liveEndedAt(endedAt)
                .peakViewerCount(42)
                .build();
        when(postService.getById(postId)).thenReturn(post);
        when(trendingScoreClient.getScores(any())).thenReturn(Map.of());

        PostInsightsResponse insights = service.getInsights(postId, authorId);

        assertThat(insights.durationSeconds()).isEqualTo(3900L);
        assertThat(insights.peakViewerCount()).isEqualTo(42);
        // Presence is cleared once a stream ends (see LiveStreamServiceImpl.end)
        // — this must not even attempt to read it.
        assertThat(insights.currentViewerCount()).isNull();
    }

    @Test
    void refusesHistoryForSomeoneElsesPost() {
        service = service();
        Post post = Post.builder().id(postId).userId(authorId).build();
        when(postService.getById(postId)).thenReturn(post);

        assertThatThrownBy(() -> service.getHistory(postId, UUID.randomUUID(), null, null))
                .isInstanceOf(NotPostOwnerException.class);
    }

    @Test
    void throws503WhenNothingHasLandedYetInsteadOfInventingAnAllZeroSeries() {
        service = service();
        Post post = Post.builder().id(postId).userId(authorId).build();
        when(postService.getById(postId)).thenReturn(post);
        when(insightsStore.queryPostRange(any(), any(), any())).thenReturn(List.of());

        assertThatThrownBy(() -> service.getHistory(postId, authorId, null, null))
                .isInstanceOf(InsightsUnavailableException.class);
    }

    @Test
    void mapsARealLandedDayIncludingWatchTimeConvertedFromMillisToSeconds() {
        service = service();
        Post post = Post.builder().id(postId).userId(authorId).build();
        when(postService.getById(postId)).thenReturn(post);
        LocalDate today = LocalDate.now(java.time.ZoneOffset.UTC);
        LocalDate from = today.minusDays(3);
        when(insightsStore.queryPostRange(postId, from, today))
                .thenReturn(List.of(item(from, 8, 90_000, false)));

        InsightsHistoryResponse response = service.getHistory(postId, authorId, from, today);

        InsightsHistoryResponse.DailyPoint firstDay = response.points().get(0);
        assertThat(firstDay.day()).isEqualTo(from);
        assertThat(firstDay.likeCount()).isEqualTo(8L);
        assertThat(firstDay.watchTimeSeconds()).isEqualTo(90L);
        assertThat(firstDay.dataStatus()).isEqualTo("COMPLETE");
        // Per-post series: creator-only fields must stay null, not a
        // misleading 0.
        assertThat(firstDay.distinctPosts()).isNull();
        assertThat(firstDay.newFollowerCount()).isNull();
    }

    @Test
    void fillsAGapDifferentlyByAgeNotJustAlwaysZero() {
        service = service();
        Post post = Post.builder().id(postId).userId(authorId).build();
        when(postService.getById(postId)).thenReturn(post);
        LocalDate today = LocalDate.now(java.time.ZoneOffset.UTC);
        LocalDate from = today.minusDays(5);
        // Only the oldest day has a landed row — every other day in the
        // range is a gap the assembly logic must fill.
        when(insightsStore.queryPostRange(postId, from, today))
                .thenReturn(List.of(item(from, 1, 1000, false)));

        InsightsHistoryResponse response = service.getHistory(postId, authorId, from, today);

        // A gap day comfortably past the 48h maturity window is a genuine
        // measured zero, not "unavailable".
        InsightsHistoryResponse.DailyPoint oldGapDay = response.points().stream()
                .filter(p -> p.day().equals(from.plusDays(1)))
                .findFirst().orElseThrow();
        assertThat(oldGapDay.dataStatus()).isEqualTo("COMPLETE");
        assertThat(oldGapDay.likeCount()).isEqualTo(0L);

        // A gap day still inside the maturity window might just not have
        // materialized yet — must not be reported as a confident zero.
        InsightsHistoryResponse.DailyPoint recentGapDay = response.points().stream()
                .filter(p -> p.day().equals(today.minusDays(1)))
                .findFirst().orElseThrow();
        assertThat(recentGapDay.dataStatus()).isEqualTo("UNAVAILABLE");
        assertThat(recentGapDay.likeCount()).isNull();

        // Any UNAVAILABLE day means the whole response is provisional, not
        // confidently complete.
        assertThat(response.dataStatus()).isEqualTo("PROVISIONAL");
    }
}
