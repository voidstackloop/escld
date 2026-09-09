package com.escld.backend.analytics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.escld.backend.dto.ObservationBatchRequest;
import com.escld.backend.warehouse.WarehouseEventPublisher;

class ObservationServiceTest {
    private final ObservationTokenService tokens = new ObservationTokenService(
            "01234567890123456789012345678901", Duration.ofHours(24));
    private final WarehouseEventPublisher publisher = mock(WarehouseEventPublisher.class);
    private final ObservationService service = new ObservationService(tokens, publisher);

    @Test
    void acceptsValidImpressionAndUsesSignedServerContext() {
        UUID viewer = UUID.randomUUID(), post = UUID.randomUUID(), request = UUID.randomUUID(), eventId = UUID.randomUUID();
        String token = tokens.issue(viewer, post, request, 3);
        var event = new ObservationBatchRequest.Event(eventId, "post.impression", Instant.now(), UUID.randomUUID(),
                token, Map.of("visibleDurationMs", 1200, "visibleFraction", 0.75));

        var response = service.accept(viewer, new ObservationBatchRequest(List.of(event)));

        assertThat(response.acceptedEventIds()).containsExactly(eventId);
        verify(publisher).publishObservation(eq(eventId), eq("post.impression"), any(), eq(viewer), eq(post),
                eq(request), eq(3), any(), any());
    }

    @Test
    void rejectsTokenFromAnotherViewerWithoutPublishing() {
        UUID owner = UUID.randomUUID();
        var event = new ObservationBatchRequest.Event(UUID.randomUUID(), "post.impression", Instant.now(), null,
                tokens.issue(owner, UUID.randomUUID(), UUID.randomUUID(), 1),
                Map.of("visibleDurationMs", 1200, "visibleFraction", 0.75));

        var response = service.accept(UUID.randomUUID(), new ObservationBatchRequest(List.of(event)));

        assertThat(response.rejected()).extracting(r -> r.code()).containsExactly("INVALID_OBSERVATION_TOKEN");
        verifyNoInteractions(publisher);
    }

    @Test
    void acceptsBoundedCumulativeDwell() {
        UUID viewer = UUID.randomUUID(), post = UUID.randomUUID(), request = UUID.randomUUID(), eventId = UUID.randomUUID();
        var event = new ObservationBatchRequest.Event(eventId, "post.dwell", Instant.now(), UUID.randomUUID(),
                tokens.issue(viewer, post, request, 4),
                Map.of("activeDwellMs", 5_000, "observationSequence", 1));

        var response = service.accept(viewer, new ObservationBatchRequest(List.of(event)));

        assertThat(response.acceptedEventIds()).containsExactly(eventId);
        verify(publisher).publishObservation(eq(eventId), eq("post.dwell"), any(), eq(viewer), eq(post),
                eq(request), eq(4), any(), any());
    }

    @Test
    void rejectsInvalidDwellWithoutPublishing() {
        UUID viewer = UUID.randomUUID();
        var event = new ObservationBatchRequest.Event(UUID.randomUUID(), "post.dwell", Instant.now(), null,
                tokens.issue(viewer, UUID.randomUUID(), UUID.randomUUID(), 1),
                Map.of("activeDwellMs", -1, "observationSequence", 0));

        var response = service.accept(viewer, new ObservationBatchRequest(List.of(event)));

        assertThat(response.rejected()).extracting(r -> r.code()).containsExactly("INVALID_DURATION");
        verifyNoInteractions(publisher);
    }

    @Test
    void acceptsBoundedCumulativeMediaProgressWithSignedFeedContext() {
        UUID viewer = UUID.randomUUID(), post = UUID.randomUUID(), request = UUID.randomUUID(), eventId = UUID.randomUUID();
        var event = new ObservationBatchRequest.Event(eventId, "media.progress", Instant.now(), UUID.randomUUID(),
                tokens.issue(viewer, post, request, 2),
                Map.of("mediaPlayedMs", 31_000, "mediaDurationMs", 60_000,
                        "playbackSequence", 3, "milestonePercent", 50));

        var response = service.accept(viewer, new ObservationBatchRequest(List.of(event)));

        assertThat(response.acceptedEventIds()).containsExactly(eventId);
        verify(publisher).publishObservation(eq(eventId), eq("media.progress"), any(), eq(viewer), eq(post),
                eq(request), eq(2), any(), any());
    }

    @Test
    void rejectsImpossibleMediaProgressWithoutPublishing() {
        UUID viewer = UUID.randomUUID();
        var event = new ObservationBatchRequest.Event(UUID.randomUUID(), "media.progress", Instant.now(), null,
                tokens.issue(viewer, UUID.randomUUID(), UUID.randomUUID(), 1),
                Map.of("mediaPlayedMs", 61_000, "mediaDurationMs", 60_000,
                        "playbackSequence", 1, "milestonePercent", 50));

        var response = service.accept(viewer, new ObservationBatchRequest(List.of(event)));

        assertThat(response.rejected()).extracting(r -> r.code()).containsExactly("INVALID_MEDIA_DURATION");
        verifyNoInteractions(publisher);
    }

    @Test
    void marksDurablyFailedEventsRetryableWithoutLosingValidEvents() {
        UUID viewer = UUID.randomUUID(), post = UUID.randomUUID(), request = UUID.randomUUID();
        UUID goodId = UUID.randomUUID(), badId = UUID.randomUUID();
        var good = new ObservationBatchRequest.Event(goodId, "post.impression", Instant.now(), UUID.randomUUID(),
                tokens.issue(viewer, post, request, 1),
                Map.of("visibleDurationMs", 1200, "visibleFraction", 0.75));
        var retryable = new ObservationBatchRequest.Event(badId, "post.impression", Instant.now(), UUID.randomUUID(),
                tokens.issue(viewer, post, request, 2),
                Map.of("visibleDurationMs", 1500, "visibleFraction", 0.8));
        org.mockito.Mockito.doThrow(new RuntimeException("db down"))
                .when(publisher).publishObservation(eq(badId), eq("post.impression"), any(), eq(viewer), eq(post),
                        eq(request), eq(2), any(), any());

        var response = service.accept(viewer, new ObservationBatchRequest(List.of(good, retryable)));

        assertThat(response.acceptedEventIds()).containsExactly(goodId);
        assertThat(response.retryableEventIds()).containsExactly(badId);
        assertThat(response.rejected()).isEmpty();
    }

    @Test
    void clampsFutureSkewToReceiptTimeAndPreservesOriginal() {
        UUID viewer = UUID.randomUUID(), post = UUID.randomUUID(), request = UUID.randomUUID(), eventId = UUID.randomUUID();
        Instant future = Instant.now().plus(Duration.ofMinutes(1));
        var event = new ObservationBatchRequest.Event(eventId, "post.impression", future, UUID.randomUUID(),
                tokens.issue(viewer, post, request, 3),
                Map.of("visibleDurationMs", 1200, "visibleFraction", 0.75));

        var response = service.accept(viewer, new ObservationBatchRequest(List.of(event)));

        assertThat(response.acceptedEventIds()).containsExactly(eventId);
        var captor = org.mockito.ArgumentCaptor.forClass(Instant.class);
        verify(publisher).publishObservation(eq(eventId), eq("post.impression"), captor.capture(), eq(viewer),
                eq(post), eq(request), eq(3), any(), any());
        assertThat(captor.getValue()).isBeforeOrEqualTo(Instant.now());
        var payloadCaptor = org.mockito.ArgumentCaptor.forClass(Map.class);
        verify(publisher).publishObservation(eq(eventId), eq("post.impression"), any(), eq(viewer), eq(post),
                eq(request), eq(3), any(), payloadCaptor.capture());
        assertThat(payloadCaptor.getValue()).containsKey("clientOccurredAt");
    }
}
