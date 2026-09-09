package com.escld.backend.config;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import io.lettuce.core.RedisClient;
import io.lettuce.core.RedisURI;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.codec.StringCodec;

/**
 * A separate connection from RateLimitConfig's — that one is byte-codec,
 * scoped to Bucket4j, and conditional on app.rate-limit.enabled; trending
 * score lookups are unrelated and shouldn't depend on that flag. Same
 * spring.data.redis.* properties as every other Redis consumer in this
 * backend resolve, though: this is the same physical ElastiCache
 * cluster/docker-compose container analytics writes trending:posts into
 * (see CacheStack — one shared cluster, not two), just a different logical
 * connection for a different command shape (String-codec sorted-set reads
 * vs. RateLimitConfig's byte-array Bucket4j protocol).
 */
@Configuration
public class TrendingConfig {

    @Bean(destroyMethod = "shutdown")
    RedisClient trendingRedisClient(
            @Value("${spring.data.redis.host:localhost}") String host,
            @Value("${spring.data.redis.port:6379}") int port) {
        return RedisClient.create(RedisURI.builder().withHost(host).withPort(port).build());
    }

    // Explicit @Qualifier for the same reason RateLimitConfig's equivalent
    // connection bean now has one — two RedisClient beans exist in this
    // context (this one and RateLimitConfig's rateLimitRedisClient), a
    // genuine ambiguity Spring can't resolve by type alone, previously only
    // masked when the compiler happened to retain parameter names.
    @Bean(destroyMethod = "close")
    StatefulRedisConnection<String, String> trendingRedisConnection(
            @Qualifier("trendingRedisClient") RedisClient trendingRedisClient) {
        return trendingRedisClient.connect(StringCodec.UTF8);
    }
}
