package com.escld.backend.config;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Duration;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.escld.backend.exceptions.AnalyticsRateLimitExceededException;
import com.escld.backend.metrics.EmfMetrics;

import io.github.bucket4j.Bucket;
import io.github.bucket4j.ConsumptionProbe;

class AnalyticsRateLimiterTest {
    private final AnalyticsIngressProperties properties = new AnalyticsIngressProperties(
            65_536, true, 20, 120, Duration.ofMinutes(1));
    private final EmfMetrics metrics = mock(EmfMetrics.class);
    private final Bucket bucket = mock(Bucket.class);
    private final AnalyticsRateLimiter limiter = new AnalyticsRateLimiter(properties, metrics, ignored -> bucket);

    @Test
    void acceptsWhenViewerBucketHasCapacity() {
        when(bucket.tryConsumeAndReturnRemaining(1)).thenReturn(ConsumptionProbe.consumed(19, 0));

        limiter.check(UUID.randomUUID());

        verify(bucket).tryConsumeAndReturnRemaining(1);
    }

    @Test
    void rejectsWithCeilingRetryAfterAndMetric() {
        when(bucket.tryConsumeAndReturnRemaining(1))
                .thenReturn(ConsumptionProbe.rejected(0, 1_500_000_001L, 1_500_000_001L));

        assertThatThrownBy(() -> limiter.check(UUID.randomUUID()))
                .isInstanceOf(AnalyticsRateLimitExceededException.class)
                .extracting("retryAfterSeconds")
                .isEqualTo(2L);
        verify(metrics).increment("analytics_ingress_rejections_total", Map.of("reason", "viewer_rate_limit"));
    }
}
