package com.escld.backend.config;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app.analytics.ingress")
public record AnalyticsIngressProperties(
        long maxRequestBytes,
        boolean rateEnabled,
        long rateCapacity,
        long refillTokens,
        Duration refillDuration) {

    public AnalyticsIngressProperties {
        if (maxRequestBytes < 1 || maxRequestBytes >= Integer.MAX_VALUE)
            throw new IllegalArgumentException("maxRequestBytes must be between 1 and Integer.MAX_VALUE - 1");
        if (rateCapacity < 1 || refillTokens < 1)
            throw new IllegalArgumentException("analytics rate limits must be positive");
        if (refillDuration == null || refillDuration.isZero() || refillDuration.isNegative())
            throw new IllegalArgumentException("analytics refillDuration must be positive");
    }
}
