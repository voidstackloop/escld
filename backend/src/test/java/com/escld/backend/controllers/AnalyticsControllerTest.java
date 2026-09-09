package com.escld.backend.controllers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.Jwt;

import com.escld.backend.analytics.ObservationService;
import com.escld.backend.config.AnalyticsRateLimiter;
import com.escld.backend.dto.ObservationBatchRequest;
import com.escld.backend.dto.ObservationBatchResponse;
import com.escld.backend.entities.User;
import com.escld.backend.services.UserService;

class AnalyticsControllerTest {

    @Test
    void resolvesViewerAndChecksTheirBucketBeforeAcceptingEvents() {
        var observations = mock(ObservationService.class);
        var users = mock(UserService.class);
        var limiter = mock(AnalyticsRateLimiter.class);
        var jwt = mock(Jwt.class);
        UUID viewerId = UUID.randomUUID();
        var viewer = User.builder().id(viewerId).build();
        var request = new ObservationBatchRequest(List.of());
        var accepted = new ObservationBatchResponse(List.of(), List.of(), List.of());
        when(users.getOrProvisionByCognitoSub(jwt)).thenReturn(viewer);
        when(observations.accept(viewerId, request)).thenReturn(accepted);

        var response = new AnalyticsController(observations, users, Optional.of(limiter)).events(jwt, request);

        assertThat(response.getStatusCode().value()).isEqualTo(202);
        var order = inOrder(users, limiter, observations);
        order.verify(users).getOrProvisionByCognitoSub(jwt);
        order.verify(limiter).check(viewerId);
        order.verify(observations).accept(viewerId, request);
    }

    @Test
    void returns503WhenNothingDurablyAcceptedButRetryRemains() {
        var observations = mock(ObservationService.class);
        var users = mock(UserService.class);
        var jwt = mock(Jwt.class);
        UUID viewerId = UUID.randomUUID();
        var viewer = User.builder().id(viewerId).build();
        var request = new ObservationBatchRequest(List.of());
        UUID retryId = UUID.randomUUID();
        var retryable = new ObservationBatchResponse(List.of(), List.of(), List.of(retryId));
        when(users.getOrProvisionByCognitoSub(jwt)).thenReturn(viewer);
        when(observations.accept(viewerId, request)).thenReturn(retryable);

        var response = new AnalyticsController(observations, users, Optional.empty()).events(jwt, request);

        assertThat(response.getStatusCode().value()).isEqualTo(503);
        assertThat(response.getBody().retryableEventIds()).containsExactly(retryId);
    }
}
