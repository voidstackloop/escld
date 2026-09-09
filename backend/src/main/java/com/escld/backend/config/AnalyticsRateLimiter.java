package com.escld.backend.config;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;

import com.escld.backend.exceptions.AnalyticsRateLimitExceededException;
import com.escld.backend.metrics.EmfMetrics;

import io.github.bucket4j.Bandwidth;
import io.github.bucket4j.Bucket;
import io.github.bucket4j.BucketConfiguration;
import io.github.bucket4j.ConsumptionProbe;
import io.github.bucket4j.Refill;
import io.github.bucket4j.distributed.proxy.ProxyManager;

/** Distributed token bucket keyed by the authenticated viewer ID. */
public class AnalyticsRateLimiter {
    private static final String KEY_PREFIX = "analytics-rate-limit:";

    private final AnalyticsIngressProperties properties;
    private final EmfMetrics emfMetrics;
    private final Function<UUID, Bucket> buckets;

    public AnalyticsRateLimiter(ProxyManager<byte[]> proxyManager, AnalyticsIngressProperties properties,
            EmfMetrics emfMetrics) {
        this(properties, emfMetrics, viewerId -> proxyManager.builder().build(
                (KEY_PREFIX + viewerId).getBytes(StandardCharsets.UTF_8),
                () -> bucketConfiguration(properties)));
    }

    AnalyticsRateLimiter(AnalyticsIngressProperties properties, EmfMetrics emfMetrics,
            Function<UUID, Bucket> buckets) {
        this.properties = properties;
        this.emfMetrics = emfMetrics;
        this.buckets = buckets;
    }

    public void check(UUID viewerId) {
        ConsumptionProbe probe = buckets.apply(viewerId).tryConsumeAndReturnRemaining(1);
        if (probe.isConsumed()) return;

        long retryAfterSeconds = Math.max(1, Math.ceilDiv(probe.getNanosToWaitForRefill(), 1_000_000_000L));
        emfMetrics.increment("analytics_ingress_rejections_total", Map.of("reason", "viewer_rate_limit"));
        throw new AnalyticsRateLimitExceededException(retryAfterSeconds);
    }

    @SuppressWarnings("deprecation")
    private static BucketConfiguration bucketConfiguration(AnalyticsIngressProperties properties) {
        Bandwidth limit = Bandwidth.classic(properties.rateCapacity(),
                Refill.greedy(properties.refillTokens(), properties.refillDuration()));
        return BucketConfiguration.builder().addLimit(limit).build();
    }
}
