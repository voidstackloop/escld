package com.escld.backend.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import com.escld.backend.metrics.EmfMetrics;

class AnalyticsRequestSizeFilterTest {
    private final AnalyticsIngressProperties properties = new AnalyticsIngressProperties(
            64, true, 20, 120, Duration.ofMinutes(1));
    private final EmfMetrics metrics = mock(EmfMetrics.class);
    private final AnalyticsRequestSizeFilter filter = new AnalyticsRequestSizeFilter(properties, metrics);

    @Test
    void rejectsPayloadAboveLimitBeforeController() throws Exception {
        var request = request("x".repeat(65));
        var response = new MockHttpServletResponse();
        var invoked = new AtomicReference<>(false);

        filter.doFilter(request, response, (req, res) -> invoked.set(true));

        assertThat(response.getStatus()).isEqualTo(413);
        assertThat(invoked).hasValue(false);
        verify(metrics).increment("analytics_ingress_rejections_total",
                java.util.Map.of("reason", "payload_too_large"));
    }

    @Test
    void rejectsOversizedBodyWhenContentLengthIsUnknown() throws Exception {
        var request = new MockHttpServletRequest("POST", "/api/v1/analytics/events") {
            @Override public int getContentLength() { return -1; }
            @Override public long getContentLengthLong() { return -1; }
        };
        request.setContent("x".repeat(65).getBytes(StandardCharsets.UTF_8));
        var response = new MockHttpServletResponse();
        var invoked = new AtomicReference<>(false);

        filter.doFilter(request, response, (req, res) -> invoked.set(true));

        assertThat(response.getStatus()).isEqualTo(413);
        assertThat(invoked).hasValue(false);
    }

    @Test
    void replaysAcceptedBodyForJsonParsing() throws Exception {
        String body = "{\"events\":[]}";
        var response = new MockHttpServletResponse();
        var received = new AtomicReference<String>();

        filter.doFilter(request(body), response, (req, res) -> received.set(
                new String(req.getInputStream().readAllBytes(), StandardCharsets.UTF_8)));

        assertThat(received).hasValue(body);
    }

    private MockHttpServletRequest request(String body) {
        var request = new MockHttpServletRequest("POST", "/api/v1/analytics/events");
        request.setContentType("application/json");
        request.setContent(body.getBytes(StandardCharsets.UTF_8));
        return request;
    }
}
