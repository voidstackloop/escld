package com.escld.backend.cache;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.cache.RedisCacheConfiguration;
import org.springframework.data.redis.cache.RedisCacheManager;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.serializer.GenericJackson2JsonRedisSerializer;
import org.springframework.data.redis.serializer.RedisSerializationContext;
import org.springframework.data.redis.serializer.StringRedisSerializer;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

/**
 * Runs against a real Redis, not mocks — proves RedisBatchCache's central,
 * otherwise-unverified design assumption: that it reconstructs the exact
 * same "<cacheName>::<key>" key format Spring Data Redis's RedisCacheManager
 * (CacheKeyPrefix.simple(), what backs every @Cacheable in this app — see
 * CacheConfig) actually produces, closely enough that a batch-cached entry
 * and a @Cacheable-driven one are genuinely the same Redis key, not two
 * assumption-based copies that only happen to look similar in a mocked
 * RedisTemplate. Builds a real RedisCacheManager side by side with a real
 * RedisBatchCache against the same container/serializer, exactly mirroring
 * CacheConfig's own bean wiring, and moves values between them directly.
 */
@Testcontainers
class RedisBatchCacheRedisIntegrationTest {

    @Container
    static GenericContainer<?> redis = new GenericContainer<>(DockerImageName.parse("redis:7-alpine"))
            .withExposedPorts(6379);

    static LettuceConnectionFactory connectionFactory;
    static RedisCacheManager cacheManager;
    static RedisBatchCache batchCache;

    @BeforeAll
    static void setUp() {
        connectionFactory = new LettuceConnectionFactory(redis.getHost(), redis.getMappedPort(6379));
        connectionFactory.afterPropertiesSet();

        GenericJackson2JsonRedisSerializer valueSerializer = new GenericJackson2JsonRedisSerializer()
                .configure(mapper -> mapper.registerModule(new JavaTimeModule()));

        RedisTemplate<String, Object> redisTemplate = new RedisTemplate<>();
        redisTemplate.setConnectionFactory(connectionFactory);
        redisTemplate.setKeySerializer(new StringRedisSerializer());
        redisTemplate.setValueSerializer(valueSerializer);
        redisTemplate.afterPropertiesSet();
        batchCache = new RedisBatchCache(redisTemplate);

        RedisCacheConfiguration cacheConfig = RedisCacheConfiguration.defaultCacheConfig()
                .entryTtl(Duration.ofMinutes(5))
                .serializeKeysWith(RedisSerializationContext.SerializationPair.fromSerializer(
                        new StringRedisSerializer()))
                .serializeValuesWith(RedisSerializationContext.SerializationPair.fromSerializer(valueSerializer));
        cacheManager = RedisCacheManager.builder(connectionFactory).cacheDefaults(cacheConfig).build();
    }

    @AfterAll
    static void tearDown() {
        connectionFactory.destroy();
    }

    @Test
    void aValuePutThroughARealCacheableStyleCacheIsReadableThroughTheBatchCache() {
        String postId = UUID.randomUUID().toString();
        cacheManager.getCache("postsById").put(postId, "hydrated-via-cacheable");

        Map<String, String> result = batchCache.getAll(
                "postsById", List.of(postId), id -> id, Duration.ofMinutes(5), missing -> Map.of());

        assertThat(result).containsEntry(postId, "hydrated-via-cacheable");
    }

    @Test
    void aValueWrittenByTheBatchCacheIsReadableThroughARealCacheableStyleCache() {
        String postId = UUID.randomUUID().toString();

        batchCache.getAll(
                "postsById", List.of(postId), id -> id, Duration.ofMinutes(5),
                missing -> Map.of(postId, "loaded-via-batch-cache"));

        assertThat(cacheManager.getCache("postsById").get(postId, String.class))
                .isEqualTo("loaded-via-batch-cache");
    }

    @Test
    void evictingTheSingleKeyCacheAlsoInvalidatesTheBatchCachedCopy() {
        // This is the whole point of sharing a keyspace: PostServiceImpl's
        // @CacheEvict calls only ever touch the single-key "postsById" cache
        // directly — if that didn't also remove a batch-cached copy, a
        // deleted/updated post could keep serving stale data through
        // FeedServiceImpl's batch path indefinitely, defeating the eviction.
        String postId = UUID.randomUUID().toString();
        cacheManager.getCache("postsById").put(postId, "will-be-evicted");

        cacheManager.getCache("postsById").evict(postId);

        Map<String, String> result = batchCache.getAll(
                "postsById", List.of(postId), id -> id, Duration.ofMinutes(5), missing -> Map.of());

        assertThat(result).isEmpty();
    }

    @Test
    void missingIdsAreResolvedThroughTheLoaderAndTheResultIsCachedForNextTime() {
        String cachedId = UUID.randomUUID().toString();
        String uncachedId = UUID.randomUUID().toString();
        cacheManager.getCache("postsById").put(cachedId, "already-cached");

        Map<String, String> result = batchCache.getAll(
                "postsById",
                List.of(cachedId, uncachedId),
                id -> id,
                Duration.ofMinutes(5),
                missing -> Map.of(uncachedId, "freshly-loaded"));

        assertThat(result).containsExactlyInAnyOrderEntriesOf(
                Map.of(cachedId, "already-cached", uncachedId, "freshly-loaded"));

        // The loader's result should now be visible through the "plain
        // @Cacheable" read path too, not just on a second batch call.
        assertThat(cacheManager.getCache("postsById").get(uncachedId, String.class))
                .isEqualTo("freshly-loaded");
    }
}
