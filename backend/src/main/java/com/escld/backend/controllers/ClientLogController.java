package com.escld.backend.controllers;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.escld.backend.dto.ClientLogRequest;

import jakarta.validation.Valid;
import lombok.extern.slf4j.Slf4j;

/**
 * The frontend previously had zero telemetry — not even a console.error
 * call anywhere. Rather than adding a dedicated error-tracking SaaS,
 * frontend crashes land here so they reach the same structured logs and
 * CloudWatch log group as every other service (see frontend/src/lib/
 * client-error-reporter.ts).
 *
 * No auth required — a crash on the login/signup page, before any session
 * exists, should still be reportable. The existing IP-based RateLimitFilter
 * already applies ahead of Spring Security to every request including this
 * one, which is the abuse protection for an unauthenticated write endpoint.
 * CorrelationIdFilter has already put this request's X-Correlation-Id (the
 * same id the frontend's failed request used, when this is reporting an API
 * failure) into MDC by the time this runs, so the log line below
 * automatically carries it.
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/client-logs")
public class ClientLogController {

    @PostMapping
    @ResponseStatus(HttpStatus.ACCEPTED)
    public void logClientError(@Valid @RequestBody ClientLogRequest request) {
        log.atError()
                .setMessage("client error")
                .addKeyValue("clientMessage", request.message())
                .addKeyValue("context", request.context())
                .log();
    }
}
