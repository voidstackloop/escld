package com.escld.backend.exceptions;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.web.context.request.WebRequest;

class GlobalExceptionHandlerAnalyticsTest {

    @Test
    void returnsRetryAfterForAnalyticsRateLimit() {
        WebRequest request = mock(WebRequest.class);
        when(request.getDescription(false)).thenReturn("uri=/api/v1/analytics/events");

        var response = new GlobalExceptionHandler().handleAnalyticsRateLimit(
                new AnalyticsRateLimitExceededException(7), request);

        assertThat(response.getStatusCode().value()).isEqualTo(429);
        assertThat(response.getHeaders().getFirst(HttpHeaders.RETRY_AFTER)).isEqualTo("7");
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().path()).isEqualTo("/api/v1/analytics/events");
    }
}
