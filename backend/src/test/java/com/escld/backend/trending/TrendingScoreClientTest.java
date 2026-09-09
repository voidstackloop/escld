package com.escld.backend.trending;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.entry;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import com.escld.backend.metrics.EmfMetrics;

import io.lettuce.core.RedisException;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.api.sync.RedisCommands;

@ExtendWith(MockitoExtension.class)
class TrendingScoreClientTest {

    @Mock
    private StatefulRedisConnection<String, String> connection;
    @Mock
    private RedisCommands<String, String> commands;
    @Mock
    private EmfMetrics emfMetrics;

    private TrendingScoreClient client;

    @Test
    void returnsAnEmptyMapWithoutTouchingRedisWhenGivenNoIds() {
        client = new TrendingScoreClient(connection, emfMetrics);

        var result = client.getScores(List.of());

        assertThat(result).isEmpty();
    }

    @Test
    void mapsEachPostIdToItsScoreInTheSameOrderTheyWereRequested() {
        client = new TrendingScoreClient(connection, emfMetrics);
        when(connection.sync()).thenReturn(commands);

        UUID trendingId = UUID.randomUUID();
        UUID untrackedId = UUID.randomUUID();
        UUID alsoTrendingId = UUID.randomUUID();
        // Arrays.asList, not List.of — ZMSCORE legitimately returns null for a
        // missing member, and List.of rejects null elements outright.
        when(commands.zmscore(anyString(), any(String[].class)))
                .thenReturn(Arrays.asList(12.5, null, 3.0));

        var result = client.getScores(List.of(trendingId, untrackedId, alsoTrendingId));

        assertThat(result).containsOnly(entry(trendingId, 12.5), entry(alsoTrendingId, 3.0));
        assertThat(result).doesNotContainKey(untrackedId);
        verify(emfMetrics).increment("trending_score_lookup_total", Map.of("result", "success", "entity_type", "posts"));
    }

    @Test
    void queriesTheSharedTrendingPostsSortedSetByKey() {
        client = new TrendingScoreClient(connection, emfMetrics);
        when(connection.sync()).thenReturn(commands);
        when(commands.zmscore(anyString(), any(String[].class))).thenReturn(List.of(1.0));

        UUID postId = UUID.randomUUID();
        client.getScores(List.of(postId));

        verify(commands).zmscore(eq("trending:posts"), eq(new String[] { postId.toString() }));
    }

    @Test
    void returnsAnEmptyMapRatherThanPropagatingWhenRedisFails() {
        client = new TrendingScoreClient(connection, emfMetrics);
        when(connection.sync()).thenReturn(commands);
        when(commands.zmscore(anyString(), any(String[].class)))
                .thenThrow(new RedisException("connection reset"));

        var result = client.getScores(List.of(UUID.randomUUID()));

        assertThat(result).isEmpty();
        verify(emfMetrics).increment("trending_score_lookup_total", Map.of("result", "failure", "entity_type", "posts"));
    }

    @Test
    void hashtagScoresReturnsAnEmptyMapWithoutTouchingRedisWhenGivenNoTags() {
        client = new TrendingScoreClient(connection, emfMetrics);

        var result = client.getHashtagScores(List.of());

        assertThat(result).isEmpty();
    }

    @Test
    void hashtagScoresMapsEachTagToItsScoreQueryingTheHashtagsSortedSet() {
        client = new TrendingScoreClient(connection, emfMetrics);
        when(connection.sync()).thenReturn(commands);
        when(commands.zmscore(anyString(), any(String[].class)))
                .thenReturn(Arrays.asList(4.0, null));

        var result = client.getHashtagScores(List.of("travel", "untracked"));

        assertThat(result).containsOnly(entry("travel", 4.0));
        verify(commands).zmscore(eq("trending:hashtags"), eq(new String[] { "travel", "untracked" }));
        verify(emfMetrics).increment("trending_score_lookup_total", Map.of("result", "success", "entity_type", "hashtags"));
    }

    @Test
    void hashtagScoresReturnsAnEmptyMapRatherThanPropagatingWhenRedisFails() {
        client = new TrendingScoreClient(connection, emfMetrics);
        when(connection.sync()).thenReturn(commands);
        when(commands.zmscore(anyString(), any(String[].class)))
                .thenThrow(new RedisException("connection reset"));

        var result = client.getHashtagScores(List.of("travel"));

        assertThat(result).isEmpty();
        verify(emfMetrics).increment("trending_score_lookup_total", Map.of("result", "failure", "entity_type", "hashtags"));
    }
}
