package com.escld.backend.config;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import org.springframework.web.filter.OncePerRequestFilter;

import com.escld.backend.metrics.EmfMetrics;

import io.github.bucket4j.Bandwidth;
import io.github.bucket4j.Bucket;
import io.github.bucket4j.BucketConfiguration;
import io.github.bucket4j.ConsumptionProbe;
import io.github.bucket4j.Refill;
import io.github.bucket4j.distributed.proxy.ProxyManager;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;

/**
 * Distributed, Redis-backed request throttling — one token bucket per client
 * IP, shared across every backend instance via Redis so limits hold under
 * horizontal scaling. Runs ahead of Spring Security so abusive traffic is
 * rejected before it pays the cost of JWT validation.
 */
@Slf4j
public class RateLimitFilter extends OncePerRequestFilter {

    private static final String KEY_PREFIX = "rate-limit:";

    private final ProxyManager<byte[]> proxyManager;
    private final RateLimitProperties properties;
    private final EmfMetrics emfMetrics;

    public RateLimitFilter(ProxyManager<byte[]> proxyManager, RateLimitProperties properties, EmfMetrics emfMetrics) {
        this.proxyManager = proxyManager;
        this.properties = properties;
        this.emfMetrics = emfMetrics;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (!properties.enabled()) {
            chain.doFilter(request, response);
            return;
        }

        Bucket bucket = resolveBucket(clientKey(request));
        ConsumptionProbe probe = bucket.tryConsumeAndReturnRemaining(1);

        response.setHeader("X-RateLimit-Limit", String.valueOf(properties.capacity()));

        if (probe.isConsumed()) {
            response.setHeader("X-RateLimit-Remaining", String.valueOf(probe.getRemainingTokens()));
            chain.doFilter(request, response);
            return;
        }

        long retryAfterSeconds = Math.max(1, probe.getNanosToWaitForRefill() / 1_000_000_000);
        log.warn("Rate limit exceeded for {}", clientKey(request));
        emfMetrics.increment("rate_limit_rejections_total", Map.of());

        response.setStatus(429);
        response.setHeader("Retry-After", String.valueOf(retryAfterSeconds));
        response.setHeader("X-RateLimit-Remaining", "0");
        response.setContentType("application/json");
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.getWriter().write("""
                {"status":429,"error":"Too Many Requests","message":"Rate limit exceeded. Retry in %d seconds."}"""
                .formatted(retryAfterSeconds));
    }

    private Bucket resolveBucket(String key) {
        byte[] keyBytes = (KEY_PREFIX + key).getBytes(StandardCharsets.UTF_8);
        return proxyManager.builder().build(keyBytes, this::bucketConfiguration);
    }

    private BucketConfiguration bucketConfiguration() {
        @SuppressWarnings("deprecation")
        Bandwidth limit = Bandwidth.classic(
                properties.capacity(),
                Refill.greedy(properties.refillTokens(), properties.refillDuration()));
        return BucketConfiguration.builder().addLimit(limit).build();
    }

    private String clientKey(HttpServletRequest request) {
        String forwardedFor = request.getHeader("X-Forwarded-For");
        if (forwardedFor != null && !forwardedFor.isBlank()) {
            return forwardedFor.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }
}
