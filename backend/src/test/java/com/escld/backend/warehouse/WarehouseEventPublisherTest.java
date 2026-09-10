package com.escld.backend.warehouse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;

import java.util.UUID;
import java.util.List;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.slf4j.MDC;

import com.escld.backend.config.CorrelationIdFilter;
import com.escld.backend.metrics.EmfMetrics;

@ExtendWith(MockitoExtension.class)
class WarehouseEventPublisherTest {

    @Mock
    private WarehouseOutboxStore outboxStore;
    @Mock
    private EmfMetrics emfMetrics;

    @AfterEach
    void clearMdc() {
        MDC.clear();
    }

    @Test
    void createsAStableVersionedOutboxEventWithCorrelationContext() {
        MDC.put(CorrelationIdFilter.MDC_KEY, "correlation-17");
        UUID postId = UUID.randomUUID();
        UUID authorId = UUID.randomUUID();
        WarehouseEventPublisher publisher = new WarehouseEventPublisher(outboxStore, emfMetrics);

        publisher.publishPostCreated(postId, authorId);

        ArgumentCaptor<WarehouseEvent> eventCaptor = ArgumentCaptor.forClass(WarehouseEvent.class);
        verify(outboxStore).enqueue(eventCaptor.capture());
        WarehouseEvent event = eventCaptor.getValue();
        assertThat(event.eventId()).isNotNull();
        assertThat(event.eventType()).isEqualTo("post.created");
        assertThat(event.eventVersion()).isEqualTo("2");
        assertThat(event.partitionKey()).isEqualTo(postId.toString());
        assertThat(event.actorId()).isEqualTo(authorId);
        assertThat(event.entityType()).isEqualTo("post");
        assertThat(event.entityId()).isEqualTo(postId.toString());
        assertThat(event.entityVersion()).isEqualTo(1L);
        assertThat(event.correlationId()).isEqualTo("correlation-17");
        assertThat(event.payload()).containsEntry("postId", postId.toString())
                .containsEntry("authorId", authorId.toString());
        verify(emfMetrics).increment("warehouse_outbox_enqueued_total", java.util.Map.of("eventType", "post.created"));
    }

    @Test
    void propagatesOutboxFailureInsteadOfReportingACommittedEvent() {
        WarehouseEventPublisher publisher = new WarehouseEventPublisher(outboxStore, emfMetrics);
        org.mockito.Mockito.doThrow(new IllegalStateException("database unavailable"))
                .when(outboxStore).enqueue(any());

        org.assertj.core.api.Assertions.assertThatThrownBy(
                () -> publisher.publishPostLiked(UUID.randomUUID(), UUID.randomUUID()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("database unavailable");
    }

    @Test
    void recordsOrderedFeedLineageWithoutSignedClientCredentials() {
        WarehouseEventPublisher publisher = new WarehouseEventPublisher(outboxStore, emfMetrics);
        UUID viewerId = UUID.randomUUID();
        UUID requestId = UUID.randomUUID();
        UUID postId = UUID.randomUUID();

        boolean accepted = publisher.publishFeedServed(viewerId, requestId,
                List.of(new WarehouseEventPublisher.ServedRecommendation(
                        postId, 1, "following_inbox", "following")),
                true, true, false, "author_affinity_boost_v1", "treatment");

        ArgumentCaptor<WarehouseEvent> eventCaptor = ArgumentCaptor.forClass(WarehouseEvent.class);
        verify(outboxStore).enqueue(eventCaptor.capture());
        WarehouseEvent event = eventCaptor.getValue();
        assertThat(accepted).isTrue();
        assertThat(event.eventType()).isEqualTo("feed.served");
        assertThat(event.partitionKey()).isEqualTo(viewerId.toString());
        assertThat(event.entityType()).isEqualTo("feed_request");
        assertThat(event.entityId()).isEqualTo(requestId.toString());
        assertThat(event.experimentId()).isEqualTo("author_affinity_boost_v1");
        assertThat(event.experimentVariant()).isEqualTo("treatment");
        assertThat(event.payload()).containsEntry("requestId", requestId.toString())
                .containsEntry("itemCount", 1)
                .containsEntry("continuation", true)
                .containsEntry("servedFromSnapshot", true)
                .containsEntry("hasMore", false);
        assertThat(event.payload()).doesNotContainKeys("cursor", "observationToken");
    }

    @Test
    void feedLineageFailureIsMeasuredWithoutFailingTheReadPath() {
        WarehouseEventPublisher publisher = new WarehouseEventPublisher(outboxStore, emfMetrics);
        org.mockito.Mockito.doThrow(new IllegalStateException("database unavailable"))
                .when(outboxStore).enqueue(any());

        boolean accepted = publisher.publishFeedServed(UUID.randomUUID(), UUID.randomUUID(), List.of(),
                false, false, false, null, null);

        assertThat(accepted).isFalse();
        verify(emfMetrics).increment("warehouse_outbox_enqueue_failed_total",
                java.util.Map.of("eventType", "feed.served"));
    }

    @Test
    void commentDeletionSeparatesCommentAuthorFromDeletionActor() {
        WarehouseEventPublisher publisher = new WarehouseEventPublisher(outboxStore, emfMetrics);
        UUID postId = UUID.randomUUID();
        UUID commentId = UUID.randomUUID();
        UUID authorId = UUID.randomUUID();
        UUID moderatorId = UUID.randomUUID();

        publisher.publishPostCommentDeleted(postId, commentId, authorId, moderatorId, "moderator");

        ArgumentCaptor<WarehouseEvent> eventCaptor = ArgumentCaptor.forClass(WarehouseEvent.class);
        verify(outboxStore).enqueue(eventCaptor.capture());
        WarehouseEvent event = eventCaptor.getValue();
        assertThat(event.eventType()).isEqualTo("post.comment_deleted");
        assertThat(event.actorId()).isEqualTo(moderatorId);
        assertThat(event.entityType()).isEqualTo("comment");
        assertThat(event.entityId()).isEqualTo(commentId.toString());
        assertThat(event.payload()).containsEntry("postId", postId.toString())
                .containsEntry("commentAuthorId", authorId.toString())
                .containsEntry("deletedById", moderatorId.toString())
                .containsEntry("deletionReason", "moderator");
    }
}
