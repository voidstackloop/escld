package com.escld.backend.counters;

import java.util.UUID;

import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Makes Postgres denormalized counters idempotent projections of stable
 * warehouse events. The DynamoDB edge remains the truth; this receipt ensures
 * a redelivered {@code post.liked/unliked} or {@code user.followed/unfollowed}
 * event (same {@code eventId} retried after an ambiguous Kafka publish, or a
 * replayed HTTP request with the same idempotency key) applies its counter
 * delta exactly once per projection version.
 *
 * <p>Usage: in the same request transaction as the counter UPDATE,
 * call {@code applyOnce(eventId, version, entityKey, counterUpdate)}.
 * Returns true only when this call newly applied the delta.
 */
@Component
public class CounterProjectionService {

    public static final int PROJECTION_VERSION = 1;

    private final NamedParameterJdbcTemplate jdbc;

    public CounterProjectionService(NamedParameterJdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public boolean tryClaim(UUID eventId, int projectionVersion, String entityKey) {
        int inserted = jdbc.update(
                """
                INSERT INTO counter_projection_receipt (event_id, projection_version, entity_key)
                VALUES (:eventId, :version, :entityKey)
                ON CONFLICT (event_id) DO NOTHING
                """,
                new MapSqlParameterSource()
                        .addValue("eventId", eventId)
                        .addValue("version", projectionVersion)
                        .addValue("entityKey", entityKey));
        return inserted == 1;
    }
}
