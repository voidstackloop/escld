package com.escld.backend.warehouse;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.header.internals.RecordHeader;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import com.escld.backend.metrics.EmfMetrics;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import lombok.extern.slf4j.Slf4j;

/**
 * Leases committed SQL outbox rows and acknowledges them only after Kafka
 * acknowledges publication. An ambiguous publish is retried with the same
 * event id; downstream consumers must therefore remain idempotent.
 */
@Slf4j
@Component
@ConditionalOnProperty(prefix = "app.kafka", name = "enabled", havingValue = "true")
public class WarehouseOutboxRelay {

    private static final String CORRELATION_ID_HEADER = "correlationId";

    private final WarehouseOutboxStore store;
    private final KafkaProducer<String, String> producer;
    private final ObjectMapper objectMapper;
    private final EmfMetrics emfMetrics;
    private final UUID workerId = UUID.randomUUID();
    private final int batchSize;
    private final Duration lease;
    private final Duration sendTimeout;
    private final Duration sentRetention;

    public WarehouseOutboxRelay(
            WarehouseOutboxStore store,
            KafkaProducer<String, String> producer,
            ObjectMapper objectMapper,
            EmfMetrics emfMetrics,
            @Value("${app.warehouse.outbox.batch-size:50}") int batchSize,
            @Value("${app.warehouse.outbox.lease:60s}") Duration lease,
            @Value("${app.warehouse.outbox.send-timeout:10s}") Duration sendTimeout,
            @Value("${app.warehouse.outbox.sent-retention:7d}") Duration sentRetention) {
        this.store = store;
        this.producer = producer;
        this.objectMapper = objectMapper;
        this.emfMetrics = emfMetrics;
        this.batchSize = Math.max(1, Math.min(batchSize, 200));
        this.lease = lease;
        this.sendTimeout = sendTimeout;
        this.sentRetention = sentRetention;
    }

    @Scheduled(fixedDelayString = "${app.warehouse.outbox.poll-delay:1s}")
    public void relayBatch() {
        List<WarehouseOutboxRecord> batch = store.claimBatch(workerId, batchSize, lease);
        for (WarehouseOutboxRecord event : batch) {
            publishOne(event);
        }
    }

    @Scheduled(fixedDelayString = "${app.warehouse.outbox.cleanup-delay:1h}", initialDelayString = "${app.warehouse.outbox.cleanup-delay:1h}")
    public void cleanSentRows() {
        int deleted = store.deleteSentBefore(Instant.now().minus(sentRetention));
        if (deleted > 0) {
            log.info("Deleted {} acknowledged warehouse outbox rows", deleted);
        }
    }

    private void publishOne(WarehouseOutboxRecord event) {
        try {
            ObjectNode envelope = objectMapper.createObjectNode();
            envelope.put("eventId", event.eventId().toString());
            envelope.put("eventType", event.eventType());
            envelope.put("eventVersion", event.eventVersion());
            envelope.put("occurredAt", event.occurredAt().toString());
            envelope.put("ingestedAt", Instant.now().toString());
            envelope.put("producer", event.producer());
            putNullable(envelope, "actorId", event.actorId() == null ? null : event.actorId().toString());
            putNullable(envelope, "entityType", event.entityType());
            putNullable(envelope, "entityId", event.entityId());
            if (event.entityVersion() == null) {
                envelope.putNull("entityVersion");
            } else {
                envelope.put("entityVersion", event.entityVersion());
            }
            putNullable(envelope, "correlationId", event.correlationId());
            if (event.sessionId() == null) envelope.putNull("sessionId");
            else envelope.put("sessionId", event.sessionId().toString());
            if (event.requestId() == null) envelope.putNull("requestId");
            else envelope.put("requestId", event.requestId().toString());
            putNullable(envelope, "experimentId", event.experimentId());
            putNullable(envelope, "experimentVariant", event.experimentVariant());
            envelope.set("payload", objectMapper.readTree(event.payloadJson()));

            ProducerRecord<String, String> record = new ProducerRecord<>(
                    event.eventType(), event.partitionKey(), objectMapper.writeValueAsString(envelope));
            if (event.correlationId() != null) {
                record.headers().add(new RecordHeader(
                        CORRELATION_ID_HEADER, event.correlationId().getBytes(StandardCharsets.UTF_8)));
            }

            producer.send(record).get(sendTimeout.toMillis(), TimeUnit.MILLISECONDS);
            if (!store.markSent(event.eventId(), workerId)) {
                log.warn("Warehouse outbox lease was lost after publishing event {}", event.eventId());
            }
            emfMetrics.increment("warehouse_outbox_publish_total", Map.of(
                    "result", "success", "eventType", event.eventType()));
        } catch (Exception e) {
            Duration retryAfter = retryDelay(event.attempts());
            store.markFailed(event.eventId(), workerId, retryAfter, rootMessage(e));
            log.warn("Failed to publish warehouse outbox event {}; retrying in {}", event.eventId(), retryAfter, e);
            emfMetrics.increment("warehouse_outbox_publish_total", Map.of(
                    "result", "failure", "eventType", event.eventType()));
        }
    }

    private void putNullable(ObjectNode node, String field, String value) {
        if (value == null) {
            node.putNull(field);
        } else {
            node.put(field, value);
        }
    }

    private Duration retryDelay(int attempts) {
        int exponent = Math.min(Math.max(attempts, 1), 8);
        return Duration.ofSeconds(Math.min(300, 1L << exponent));
    }

    private String rootMessage(Exception error) {
        Throwable current = error;
        while (current.getCause() != null) {
            current = current.getCause();
        }
        return current.getMessage() == null ? current.getClass().getSimpleName() : current.getMessage();
    }
}
