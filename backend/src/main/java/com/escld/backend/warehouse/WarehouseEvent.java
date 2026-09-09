package com.escld.backend.warehouse;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * Immutable application event written to the SQL outbox. The event id and
 * occurred-at timestamp are assigned before persistence and remain stable
 * through every Kafka retry.
 */
public record WarehouseEvent(
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
        Map<String, Object> payload) {
}
