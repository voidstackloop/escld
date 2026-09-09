package com.escld.backend.exceptions;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ResponseStatus;

/** Materialized insights unavailable (neither DynamoDB materialized store nor
 * Redis cache can answer). Clients retry with backoff; 503 distinguishes
 * "no data yet" from measured-zero (which returns 200 with nullable metrics
 * and dataStatus). */
@ResponseStatus(HttpStatus.SERVICE_UNAVAILABLE)
public class InsightsUnavailableException extends RuntimeException {
    public InsightsUnavailableException(String message) {
        super(message);
    }
}
