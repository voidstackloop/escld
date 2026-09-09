package com.escld.backend.config;

import java.io.IOException;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;

/**
 * One structured log line per request: method, path, status, duration, client IP.
 * Runs right after rate limiting, ahead of Spring Security, so every request
 * that reaches the app — including ones rejected by auth — gets logged.
 *
 * Ordered one tick behind CorrelationIdFilter (HIGHEST_PRECEDENCE + 1, not
 * HIGHEST_PRECEDENCE) so this line's MDC already carries correlationId by
 * the time it logs.
 *
 * Uses SLF4J's fluent key-value API (addKeyValue) rather than string
 * interpolation so method/path/status/durationMs/clientIp land as first-class
 * JSON fields under structured logging (LOG_FORMAT=ecs), queryable in
 * CloudWatch Logs Insights instead of regex-parsed out of one message string.
 */
@Slf4j
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 1)
public class RequestLoggingFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        long startNanos = System.nanoTime();
        try {
            chain.doFilter(request, response);
        } finally {
            long durationMs = (System.nanoTime() - startNanos) / 1_000_000;
            log.atInfo()
                    .setMessage("request handled")
                    .addKeyValue("method", request.getMethod())
                    .addKeyValue("path", request.getRequestURI())
                    .addKeyValue("status", response.getStatus())
                    .addKeyValue("durationMs", durationMs)
                    .addKeyValue("clientIp", clientIp(request))
                    .log();
        }
    }

    private String clientIp(HttpServletRequest request) {
        String forwardedFor = request.getHeader("X-Forwarded-For");
        if (forwardedFor != null && !forwardedFor.isBlank()) {
            return forwardedFor.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }
}
