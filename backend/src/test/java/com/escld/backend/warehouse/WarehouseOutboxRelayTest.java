package com.escld.backend.warehouse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import com.escld.backend.metrics.EmfMetrics;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

@ExtendWith(MockitoExtension.class)
class WarehouseOutboxRelayTest {

    @Mock
    private WarehouseOutboxStore store;
    @Mock
    private KafkaProducer<String, String> producer;
    @Mock
    private EmfMetrics emfMetrics;

    @Test
    void publishesTheClaimedEventWithItsStableIdAndAcknowledgesTheLease() throws Exception {
        UUID eventId = UUID.randomUUID();
        UUID actorId = UUID.randomUUID();
        UUID requestId = UUID.randomUUID();
        WarehouseOutboxRecord event = new WarehouseOutboxRecord(
                eventId, "post.created", "2", "post-1", Instant.parse("2026-09-05T12:00:00Z"),
                "backend", actorId, "post", "post-1", 1L, "correlation-1",
                null, requestId, null, null,
                "{\"postId\":\"post-1\"}", 1);
        when(store.claimBatch(any(), eq(50), eq(Duration.ofSeconds(60)))).thenReturn(List.of(event));
        when(producer.send(any())).thenReturn(CompletableFuture.completedFuture(null));
        when(store.markSent(eq(eventId), any())).thenReturn(true);

        WarehouseOutboxRelay relay = relay();
        relay.relayBatch();

        @SuppressWarnings("unchecked")
        ArgumentCaptor<ProducerRecord<String, String>> recordCaptor = ArgumentCaptor.forClass(ProducerRecord.class);
        verify(producer).send(recordCaptor.capture());
        ProducerRecord<String, String> record = recordCaptor.getValue();
        assertThat(record.topic()).isEqualTo("post.created");
        assertThat(record.key()).isEqualTo("post-1");
        assertThat(record.headers().lastHeader("correlationId").value())
                .isEqualTo("correlation-1".getBytes(StandardCharsets.UTF_8));

        JsonNode envelope = new ObjectMapper().readTree(record.value());
        assertThat(envelope.path("eventId").asText()).isEqualTo(eventId.toString());
        assertThat(envelope.path("eventVersion").asText()).isEqualTo("2");
        assertThat(envelope.path("actorId").asText()).isEqualTo(actorId.toString());
        assertThat(envelope.path("requestId").asText()).isEqualTo(requestId.toString());
        assertThat(envelope.path("payload").path("postId").asText()).isEqualTo("post-1");
        verify(store).markSent(eq(eventId), any());
    }

    @Test
    void releasesAFailedPublishWithBackoff() {
        UUID eventId = UUID.randomUUID();
        WarehouseOutboxRecord event = new WarehouseOutboxRecord(
                eventId, "post.created", "2", "post-1", Instant.now(), "backend",
                null, "post", "post-1", 1L, null, null, null, null, null, "{}", 3);
        when(store.claimBatch(any(), eq(50), eq(Duration.ofSeconds(60)))).thenReturn(List.of(event));
        when(producer.send(any())).thenReturn(CompletableFuture.failedFuture(new IllegalStateException("broker down")));

        relay().relayBatch();

        verify(store).markFailed(eq(eventId), any(), eq(Duration.ofSeconds(8)), eq("broker down"));
    }

    private WarehouseOutboxRelay relay() {
        return new WarehouseOutboxRelay(
                store, producer, new ObjectMapper(), emfMetrics,
                50, Duration.ofSeconds(60), Duration.ofSeconds(10), Duration.ofDays(7));
    }
}
