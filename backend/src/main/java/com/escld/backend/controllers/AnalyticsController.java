package com.escld.backend.controllers;

import java.util.Optional;

import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.escld.backend.analytics.ObservationService;
import com.escld.backend.config.AnalyticsRateLimiter;
import com.escld.backend.dto.ObservationBatchRequest;
import com.escld.backend.dto.ObservationBatchResponse;
import com.escld.backend.services.UserService;

import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;

@RestController
@RequestMapping("/api/v1/analytics")
@RequiredArgsConstructor
public class AnalyticsController {
    private final ObservationService observationService;
    private final UserService userService;
    private final Optional<AnalyticsRateLimiter> rateLimiter;

    @PostMapping("/events")
    public ResponseEntity<ObservationBatchResponse> events(@AuthenticationPrincipal Jwt jwt,
            @Valid @RequestBody ObservationBatchRequest request) {
        var viewer = userService.getOrProvisionByCognitoSub(jwt);
        rateLimiter.ifPresent(limiter -> limiter.check(viewer.getId()));
        var response = observationService.accept(viewer.getId(), request);
        // 503 when no valid event could be durably accepted but retryable
        // work remains; per-event errors never reject unrelated valid events.
        if (response.acceptedEventIds().isEmpty() && !response.retryableEventIds().isEmpty()) {
            return ResponseEntity.status(503).body(response);
        }
        return ResponseEntity.accepted().body(response);
    }
}
