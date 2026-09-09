package com.escld.backend.exceptions;

public class AnalyticsRateLimitExceededException extends RuntimeException {
    private final long retryAfterSeconds;

    public AnalyticsRateLimitExceededException(long retryAfterSeconds) {
        super("Analytics rate limit exceeded. Retry in " + retryAfterSeconds + " seconds.");
        this.retryAfterSeconds = retryAfterSeconds;
    }

    public long retryAfterSeconds() {
        return retryAfterSeconds;
    }
}
