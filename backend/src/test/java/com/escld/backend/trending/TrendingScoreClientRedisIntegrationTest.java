package com.escld.backend.trending;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import com.escld.backend.metrics.EmfMetrics;

import io.lettuce.core.RedisClient;
import io.lettuce.core.RedisURI;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.api.sync.RedisCommands;
import io.lettuce.core.codec.StringCodec;

/**
 * Runs against a real Redis container, not a mock — the whole point of this
 * feature (see the enterprise-hardening/feed-ranking plan) was making
 * TrendingScoreClient actually talk to the same physical store `analytics`
 * writes to, so TrendingScoreClientTest's mocked-command-shape coverage isn't
 * enough on its own to trust the real ZMSCORE round trip. Seeds the sorted
 * set the exact way analytics/src/trending.ts's TrendingStore does
 * (ZINCRBY-equivalent scores under key "trending:posts", member = postId) to
 * keep this test honest about the actual cross-service contract, not just an
 * arbitrary fixture.
 */
@Testcontainers
class TrendingScoreClientRedisIntegrationTest {

    @Container
    static GenericContainer<?> redis = new GenericContainer<>(DockerImageName.parse("redis:7-alpine"))
            .withExposedPorts(6379);

    static RedisClient redisClient;
    static StatefulRedisConnection<String, String> connection;

    @BeforeAll
    static void setUp() {
        redisClient = RedisClient.create(
                RedisURI.builder().withHost(redis.getHost()).withPort(redis.getMappedPort(6379)).build());
        connection = redisClient.connect(StringCodec.UTF8);
    }

    @AfterAll
    static void tearDown() {
        connection.close();
        redisClient.shutdown();
    }

    @Test
    void fetchesRealScoresForTrackedPostsAndOmitsUntrackedOnes() {
        RedisCommands<String, String> commands = connection.sync();
        UUID trendingPostId = UUID.randomUUID();
        UUID otherTrendingPostId = UUID.randomUUID();
        UUID untrackedPostId = UUID.randomUUID();

        // Same shape analytics/src/trending.ts's TrendingStore.record() writes:
        // key "trending:posts", member = postId, score = cumulative weight.
        commands.zadd("trending:posts", 8.5, trendingPostId.toString());
        commands.zadd("trending:posts", 3.0, otherTrendingPostId.toString());

        TrendingScoreClient client = new TrendingScoreClient(connection, new EmfMetrics());
        Map<UUID, Double> scores = client.getScores(List.of(trendingPostId, otherTrendingPostId, untrackedPostId));

        assertThat(scores).containsExactlyInAnyOrderEntriesOf(
                Map.of(trendingPostId, 8.5, otherTrendingPostId, 3.0));
        assertThat(scores).doesNotContainKey(untrackedPostId);
    }

    @Test
    void reflectsScoreChangesLiveJustLikeTheRealTrendingPipelineWould() {
        RedisCommands<String, String> commands = connection.sync();
        UUID postId = UUID.randomUUID();
        commands.zadd("trending:posts", 1.0, postId.toString());

        TrendingScoreClient client = new TrendingScoreClient(connection, new EmfMetrics());
        assertThat(client.getScores(List.of(postId))).containsEntry(postId, 1.0);

        // A like/comment event would ZINCRBY this in the real pipeline —
        // simulate one and confirm the next read picks it up immediately,
        // same as feed ranking would on the next request.
        commands.zincrby("trending:posts", 5.0, postId.toString());
        assertThat(client.getScores(List.of(postId))).containsEntry(postId, 6.0);
    }

    @Test
    void fetchesRealHashtagScoresFromTheSiblingSortedSet() {
        RedisCommands<String, String> commands = connection.sync();
        // Same shape analytics/src/events.ts writes: key "trending:hashtags",
        // member = lowercased tag, score = cumulative weight.
        commands.zadd("trending:hashtags", 6.0, "travel");
        commands.zadd("trending:hashtags", 2.0, "food");

        TrendingScoreClient client = new TrendingScoreClient(connection, new EmfMetrics());
        Map<String, Double> scores = client.getHashtagScores(List.of("travel", "food", "untracked"));

        assertThat(scores).containsExactlyInAnyOrderEntriesOf(Map.of("travel", 6.0, "food", 2.0));
        assertThat(scores).doesNotContainKey("untracked");
    }
}
