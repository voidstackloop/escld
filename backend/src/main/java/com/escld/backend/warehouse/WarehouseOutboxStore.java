package com.escld.backend.warehouse;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Persists and leases warehouse events. enqueue() joins the caller's current
 * transaction, coupling a relational state change and its event without a
 * database/Kafka dual write. Claim transactions are deliberately short: a
 * broker call never holds a database row lock.
 */
@Component
public class WarehouseOutboxStore {

    private final NamedParameterJdbcTemplate jdbc;
    private final ObjectMapper objectMapper;

    public WarehouseOutboxStore(NamedParameterJdbcTemplate jdbc, ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    public void enqueue(WarehouseEvent event) {
        String payload;
        try {
            payload = objectMapper.writeValueAsString(event.payload());
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Warehouse event payload cannot be serialized", e);
        }

        jdbc.update("""
                INSERT INTO warehouse_outbox (
                    id, event_type, event_version, partition_key, occurred_at,
                    producer, actor_id, entity_type, entity_id, entity_version,
                    correlation_id, session_id, request_id, experiment_id, experiment_variant, payload
                ) VALUES (
                    :id, :eventType, :eventVersion, :partitionKey, :occurredAt,
                    :producer, :actorId, :entityType, :entityId, :entityVersion,
                    :correlationId, :sessionId, :requestId, :experimentId, :experimentVariant, CAST(:payload AS jsonb)
                )
                ON CONFLICT (id) DO NOTHING
                """, new MapSqlParameterSource()
                .addValue("id", event.eventId())
                .addValue("eventType", event.eventType())
                .addValue("eventVersion", event.eventVersion())
                .addValue("partitionKey", event.partitionKey())
                .addValue("occurredAt", Timestamp.from(event.occurredAt()))
                .addValue("producer", event.producer())
                .addValue("actorId", event.actorId())
                .addValue("entityType", event.entityType())
                .addValue("entityId", event.entityId())
                .addValue("entityVersion", event.entityVersion())
                .addValue("correlationId", event.correlationId())
                .addValue("sessionId", event.sessionId())
                .addValue("requestId", event.requestId())
                .addValue("experimentId", event.experimentId())
                .addValue("experimentVariant", event.experimentVariant())
                .addValue("payload", payload));
    }

    /**
     * Claims eligible rows with SKIP LOCKED so every backend replica can run
     * the relay. Expired leases are reclaimed after a process crash.
     */
    @Transactional
    public List<WarehouseOutboxRecord> claimBatch(UUID workerId, int batchSize, Duration lease) {
        return jdbc.query("""
                WITH candidates AS (
                    SELECT candidate.id
                    FROM warehouse_outbox AS candidate
                    WHERE candidate.sent_at IS NULL
                      AND candidate.available_at <= now()
                      AND (candidate.claimed_until IS NULL OR candidate.claimed_until < now())
                      AND NOT EXISTS (
                          SELECT 1
                          FROM warehouse_outbox AS predecessor
                          WHERE predecessor.sent_at IS NULL
                            AND predecessor.partition_key = candidate.partition_key
                            AND (predecessor.occurred_at, predecessor.id)
                                < (candidate.occurred_at, candidate.id)
                      )
                    ORDER BY candidate.occurred_at, candidate.id
                    FOR UPDATE SKIP LOCKED
                    LIMIT :batchSize
                )
                UPDATE warehouse_outbox AS outbox
                SET claimed_by = :workerId,
                    claimed_until = now() + (:leaseSeconds * interval '1 second'),
                    attempts = attempts + 1
                FROM candidates
                WHERE outbox.id = candidates.id
                RETURNING outbox.*
                """, Map.of(
                        "workerId", workerId,
                        "batchSize", batchSize,
                        "leaseSeconds", Math.max(1, lease.toSeconds())),
                this::mapRecord);
    }

    public boolean markSent(UUID eventId, UUID workerId) {
        return jdbc.update("""
                UPDATE warehouse_outbox
                SET sent_at = now(), claimed_by = NULL, claimed_until = NULL, last_error = NULL
                WHERE id = :eventId AND claimed_by = :workerId AND sent_at IS NULL
                """, Map.of("eventId", eventId, "workerId", workerId)) == 1;
    }

    public boolean markFailed(UUID eventId, UUID workerId, Duration retryAfter, String error) {
        return jdbc.update("""
                UPDATE warehouse_outbox
                SET available_at = now() + (:retrySeconds * interval '1 second'),
                    claimed_by = NULL,
                    claimed_until = NULL,
                    last_error = left(:error, 2000)
                WHERE id = :eventId AND claimed_by = :workerId AND sent_at IS NULL
                """, new MapSqlParameterSource()
                .addValue("eventId", eventId)
                .addValue("workerId", workerId)
                .addValue("retrySeconds", Math.max(1, retryAfter.toSeconds()))
                .addValue("error", error == null ? "unknown Kafka publish failure" : error)) == 1;
    }

    public int deleteSentBefore(Instant cutoff) {
        return jdbc.update(
                "DELETE FROM warehouse_outbox WHERE sent_at < :cutoff",
                Map.of("cutoff", Timestamp.from(cutoff)));
    }

    private WarehouseOutboxRecord mapRecord(ResultSet rs, int rowNumber) throws SQLException {
        Number entityVersion = (Number) rs.getObject("entity_version");
        return new WarehouseOutboxRecord(
                rs.getObject("id", UUID.class),
                rs.getString("event_type"),
                rs.getString("event_version"),
                rs.getString("partition_key"),
                rs.getTimestamp("occurred_at").toInstant(),
                rs.getString("producer"),
                rs.getObject("actor_id", UUID.class),
                rs.getString("entity_type"),
                rs.getString("entity_id"),
                entityVersion == null ? null : entityVersion.longValue(),
                rs.getString("correlation_id"),
                rs.getObject("session_id", UUID.class),
                rs.getObject("request_id", UUID.class),
                rs.getString("experiment_id"),
                rs.getString("experiment_variant"),
                rs.getString("payload"),
                rs.getInt("attempts"));
    }
}
