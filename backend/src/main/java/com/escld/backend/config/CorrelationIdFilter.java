package com.escld.backend.config;

import java.io.IOException;
import java.util.UUID;

import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * Reads X-Correlation-Id from the incoming request, or generates one, and
 * puts it in MDC for the life of the request — every log line emitted while
 * handling it (including RequestLoggingFilter's own line) picks it up
 * automatically once structured logging is on (LOG_FORMAT=ecs). Echoed back
 * as a response header so the frontend's own client-side error log
 * (ClientLogController) can be cross-referenced with this request's logs.
 *
 * Ordered ahead of RequestLoggingFilter (HIGHEST_PRECEDENCE + 1) so that
 * filter's log line already has the correlation ID in MDC by the time it runs.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class CorrelationIdFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Correlation-Id";
    public static final String MDC_KEY = "correlationId";

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String correlationId = request.getHeader(HEADER);
        if (correlationId == null || correlationId.isBlank()) {
            correlationId = UUID.randomUUID().toString();
        }
        MDC.put(MDC_KEY, correlationId);
        response.setHeader(HEADER, correlationId);
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.remove(MDC_KEY);
        }
    }
}
