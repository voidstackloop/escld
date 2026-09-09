package com.escld.backend.config;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;

import com.escld.backend.metrics.EmfMetrics;

import io.github.bucket4j.distributed.proxy.ProxyManager;
import io.github.bucket4j.redis.lettuce.cas.LettuceBasedProxyManager;
import io.lettuce.core.RedisClient;
import io.lettuce.core.RedisURI;
import io.lettuce.core.codec.ByteArrayCodec;
import io.lettuce.core.api.StatefulRedisConnection;

@Configuration
@EnableConfigurationProperties(RateLimitProperties.class)
@ConditionalOnProperty(prefix = "app.rate-limit", name = "enabled", havingValue = "true", matchIfMissing = true)
public class RateLimitConfig {

    @Bean
    @ConditionalOnProperty(prefix = "app.analytics.ingress", name = "rate-enabled", havingValue = "true",
            matchIfMissing = true)
    AnalyticsRateLimiter analyticsRateLimiter(ProxyManager<byte[]> proxyManager,
            AnalyticsIngressProperties properties, EmfMetrics emfMetrics) {
        return new AnalyticsRateLimiter(proxyManager, properties, emfMetrics);
    }

    @Bean(destroyMethod = "shutdown")
    RedisClient rateLimitRedisClient(
            @Value("${spring.data.redis.host:localhost}") String host,
            @Value("${spring.data.redis.port:6379}") int port) {
        return RedisClient.create(RedisURI.builder().withHost(host).withPort(port).build());
    }

    // Explicit @Qualifier, not relying on Spring's by-parameter-name fallback
    // for ambiguous-by-type autowiring — TrendingConfig's trendingRedisClient
    // bean is a second RedisClient in this context (a separate connection by
    // design, see that class's own doc), so without this, bean resolution
    // here is genuinely ambiguous regardless of how the project's compiler
    // flags happen to be configured.
    @Bean(destroyMethod = "close")
    StatefulRedisConnection<byte[], byte[]> rateLimitRedisConnection(
            @Qualifier("rateLimitRedisClient") RedisClient redisClient) {
        return redisClient.connect(ByteArrayCodec.INSTANCE);
    }

    @SuppressWarnings("deprecation")
    @Bean
    ProxyManager<byte[]> rateLimitProxyManager(StatefulRedisConnection<byte[], byte[]> connection) {
        return LettuceBasedProxyManager.builderFor(connection).build();
    }

    @Bean
    FilterRegistrationBean<RateLimitFilter> rateLimitFilterRegistration(
            ProxyManager<byte[]> proxyManager, RateLimitProperties properties, EmfMetrics emfMetrics) {
        FilterRegistrationBean<RateLimitFilter> registration = new FilterRegistrationBean<>(
                new RateLimitFilter(proxyManager, properties, emfMetrics));
        registration.addUrlPatterns("/api/*");
        // Ahead of Spring Security's filter chain (registered at
        // SecurityProperties.DEFAULT_FILTER_ORDER = -100)
        // so throttled requests never pay the cost of JWT validation.
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return registration;
    }
}
