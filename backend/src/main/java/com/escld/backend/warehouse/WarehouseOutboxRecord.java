package com.escld.backend.warehouse;

import java.time.Instant;
import java.util.UUID;

/** A claimed outbox row ready for one Kafka publication attempt. */
public record WarehouseOutboxRecord(
        UUID eventId,
        String eventType,
        String eventVersion,
        String partitionKey,
        Instant occurredAt,
        String producer,
        UUID actorId,
        String entityType,
        String entityId,
        Long entityVersion,
        String correlationId,
        UUID sessionId,
        UUID requestId,
        String experimentId,
        String experimentVariant,
        String payloadJson,
        int attempts) {
}
