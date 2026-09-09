package com.escld.backend.config;

import java.time.Duration;

import org.springframework.boot.cache.autoconfigure.RedisCacheManagerBuilderCustomizer;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.cache.RedisCacheConfiguration;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.serializer.GenericJackson2JsonRedisSerializer;
import org.springframework.data.redis.serializer.RedisSerializationContext;
import org.springframework.data.redis.serializer.StringRedisSerializer;

import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

/**
 * User-lookup caching (see UserServiceImpl) — resolving "who is the current
 * user" happens on essentially every authenticated request, so this is the
 * single highest-value read to take off Postgres. A short TTL rather than
 * event-driven invalidation for every field: this repo already treats
 * followers/following/posts counts as best-effort-consistent (see
 * FollowServiceImpl's javadoc), so a few seconds of staleness on those same
 * fields via a cache is the same trade-off, not a new one.
 *
 * postsById/commentsByPostId (see PostServiceImpl/CommentServiceImpl) extend
 * the same approach to the next two highest-reuse reads in the backend —
 * unlike the user caches, their PRIMARY invalidation is explicit
 * @CacheEvict on the writes that actually change them (a post's like/comment
 * count is mutated via a bulk UPDATE that bypasses the cached entity
 * entirely — see PostService's four count-wrapper methods — so relying on
 * TTL alone would mean the API could show a stale count on the very request
 * that just changed it, not just "eventually consistent," a real bug not a
 * staleness trade-off). The longer TTL here is a safety net for any future
 * write path that forgets to evict, not the intended mechanism.
 *
 * userSearchResults (see SearchServiceImpl) has no per-user data or write
 * path to evict on at all — a short TTL is the entire invalidation strategy,
 * matching the user caches' own reasoning (new signups being briefly absent
 * from search results is an acceptable trade at this app's scale).
 *
 * TTLs are public: RedisBatchCache call sites (e.g. FeedServiceImpl's bulk
 * post/author fetches) need to write entries with the *same* TTL a
 * @Cacheable-driven read on that same cache name would use — a mismatched
 * TTL wouldn't break correctness (eviction still cleans up either copy) but
 * would silently reintroduce staleness windows this file's own reasoning
 * above accounts for.
 */
@Configuration
@EnableCaching
public class CacheConfig {

    public static final Duration USER_CACHE_TTL = Duration.ofSeconds(30);
    public static final Duration ENTITY_CACHE_TTL = Duration.ofMinutes(5);
    public static final Duration SEARCH_CACHE_TTL = Duration.ofSeconds(30);

    @Bean
    GenericJackson2JsonRedisSerializer redisValueSerializer() {
        // Values default to JDK serialization, which requires the cached
        // type to implement Serializable — the JPA entities here don't (and
        // shouldn't have to just to satisfy a cache). JSON serialization
        // works against any POJO and is far easier to inspect in Redis
        // directly (`redis-cli GET ...`) while debugging.
        //
        // The no-arg constructor's internal ObjectMapper has default typing
        // enabled (writes a "@class" field into the stored JSON), which is
        // what lets deserialization reconstruct a `User` instead of handing
        // back a plain LinkedHashMap — passing in a fully custom ObjectMapper
        // instead (e.g. `new GenericJackson2JsonRedisSerializer(mapper)`)
        // skips that setup and breaks exactly that way. `.configure(...)`
        // only adds to its own mapper rather than replacing it, so
        // JavaTimeModule (needed for User.createdAt/updatedAt, an Instant)
        // gets added without losing default typing. jackson-datatype-jsr310
        // is a direct dependency (see pom.xml) so this compiles without
        // relying on it merely being present transitively at runtime.
        //
        // A bean (not a local variable) specifically so RedisBatchCache's own
        // RedisTemplate (see batchCacheRedisTemplate below) can share this
        // exact instance — same serialization format everywhere means a
        // batch-cache write and a @Cacheable-driven read (or eviction) on the
        // same cache name/key genuinely agree on wire format, not two
        // subtly-incompatible copies of the same data.
        return new GenericJackson2JsonRedisSerializer()
                .configure(mapper -> mapper.registerModule(new JavaTimeModule()));
    }

    @Bean
    RedisCacheManagerBuilderCustomizer userCacheCustomizer(GenericJackson2JsonRedisSerializer redisValueSerializer) {
        RedisCacheConfiguration userConfig = baseConfig(redisValueSerializer, USER_CACHE_TTL);
        RedisCacheConfiguration entityConfig = baseConfig(redisValueSerializer, ENTITY_CACHE_TTL);
        RedisCacheConfiguration searchConfig = baseConfig(redisValueSerializer, SEARCH_CACHE_TTL);

        return builder -> builder
                .withCacheConfiguration("usersById", userConfig)
                .withCacheConfiguration("usersByUsername", userConfig)
                .withCacheConfiguration("usersByCognitoSub", userConfig)
                .withCacheConfiguration("postsById", entityConfig)
                .withCacheConfiguration("commentsByPostId", entityConfig)
                .withCacheConfiguration("userSearchResults", searchConfig);
    }

    /**
     * Backs RedisBatchCache (see the cache/ package) — Spring's Cache
     * interface has no multi-get primitive (confirmed directly against the
     * resolved spring-data-redis jar), so bulk lookups like FeedServiceImpl's
     * findAllById-shaped reads can't go through @Cacheable at all; they need
     * RedisTemplate's own multiGet/set directly. Keys use the same
     * StringRedisSerializer and values the same shared redisValueSerializer
     * as RedisCacheManager above, and RedisBatchCache itself reconstructs
     * RedisCacheManager's "<cacheName>::<key>" key format (CacheKeyPrefix.
     * simple()) — that pairing is what lets a single-key @CacheEvict on, say,
     * "postsById" also invalidate a batch-cached copy of that same post.
     */
    @Bean
    RedisTemplate<String, Object> batchCacheRedisTemplate(
            RedisConnectionFactory connectionFactory, GenericJackson2JsonRedisSerializer redisValueSerializer) {
        RedisTemplate<String, Object> template = new RedisTemplate<>();
        template.setConnectionFactory(connectionFactory);
        template.setKeySerializer(new StringRedisSerializer());
        template.setValueSerializer(redisValueSerializer);
        template.afterPropertiesSet();
        return template;
    }

    private RedisCacheConfiguration baseConfig(GenericJackson2JsonRedisSerializer valueSerializer, Duration ttl) {
        return RedisCacheConfiguration.defaultCacheConfig()
                .entryTtl(ttl)
                .disableCachingNullValues()
                .serializeKeysWith(RedisSerializationContext.SerializationPair.fromSerializer(
                        new StringRedisSerializer()))
                .serializeValuesWith(RedisSerializationContext.SerializationPair.fromSerializer(valueSerializer));
    }
}
