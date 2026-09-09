package com.escld.backend.exceptions;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.context.request.ServletWebRequest;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.mock.web.MockHttpServletRequest;

/**
 * Real regression coverage for the bug live-testing GET /users/me/insights
 * found: a domain exception with no explicit @ExceptionHandler entry here
 * falls through to the Exception.class catch-all and reports 500, silently
 * ignoring its own @ResponseStatus annotation. Every unit test elsewhere in
 * this codebase calls the service layer directly, which never exercises
 * this class at all — this is the first direct test of it.
 */
class GlobalExceptionHandlerTest {

    private final GlobalExceptionHandler handler = new GlobalExceptionHandler();

    private ServletWebRequest request() {
        HttpServletRequest servletRequest = new MockHttpServletRequest("GET", "/api/v1/users/me/insights");
        return new ServletWebRequest(servletRequest);
    }

    @Test
    void reportsInsightsUnavailableAs503NotTheGenericCatchAll500() {
        ResponseEntity<ApiError> response = handler.handleInsightsUnavailable(
                new InsightsUnavailableException("No materialized insights landed yet"), request());

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        assertThat(response.getBody().status()).isEqualTo(503);
        assertThat(response.getBody().message()).isEqualTo("No materialized insights landed yet");
    }

    @Test
    void anExceptionWithNoExplicitHandlerStillReports500ThroughTheCatchAll() {
        ResponseEntity<ApiError> response = handler.handleUnexpected(new RuntimeException("boom"), request());

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
        // The real bug: an unhandled exception must never leak its raw
        // message to the client.
        assertThat(response.getBody().message()).isEqualTo("An unexpected error occurred");
    }
}
