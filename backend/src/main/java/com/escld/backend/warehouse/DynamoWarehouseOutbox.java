package com.escld.backend.warehouse;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import com.escld.backend.config.CorrelationIdFilter;
import com.escld.backend.metrics.EmfMetrics;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.Put;
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItem;

/**
 * Builds warehouse outbox items that can participate in the same DynamoDB
 * transaction as domain state. The caller owns the transaction so an edge
 * and its event either both commit or neither does.
 */
@Component
public class DynamoWarehouseOutbox {

    public static final String PENDING_INDEX = "byPendingTime";
    public static final int SHARD_COUNT = 16;

    private final String tableName;
    private final ObjectMapper objectMapper;
    private final EmfMetrics emfMetrics;

    // Explicit @Autowired: with a second (test-only) constructor also present,
    // Spring can no longer fall back to its "exactly one constructor implies
    // autowire it" convenience — without this it silently tries the class's
    // nonexistent no-arg constructor instead of either real one and fails
    // startup with "No default constructor found".
    @Autowired
    public DynamoWarehouseOutbox(
            @Value("${app.dynamodb.domain-outbox-table-name}") String tableName,
            ObjectMapper objectMapper,
            EmfMetrics emfMetrics) {
        this.tableName = tableName;
        this.objectMapper = objectMapper;
        this.emfMetrics = emfMetrics;
    }

    /** Constructor used by store integration tests without a Spring context. */
    public DynamoWarehouseOutbox(String tableName, ObjectMapper objectMapper) {
        this(tableName, objectMapper, null);
    }

    public WarehouseEvent postLiked(UUID postId, UUID userId) {
        return postLiked(UUID.randomUUID(), postId, userId);
    }

    public WarehouseEvent postLiked(UUID eventId, UUID postId, UUID userId) {
        return event(eventId, "post.liked", postId.toString(), userId, "post_like", postId + ":" + userId,
                Map.of("postId", postId.toString(), "userId", userId.toString()));
    }

    public WarehouseEvent postUnliked(UUID postId, UUID userId) {
        return postUnliked(UUID.randomUUID(), postId, userId);
    }

    public WarehouseEvent postUnliked(UUID eventId, UUID postId, UUID userId) {
        return event(eventId, "post.unliked", postId.toString(), userId, "post_like", postId + ":" + userId,
                Map.of("postId", postId.toString(), "userId", userId.toString()));
    }

    public WarehouseEvent userFollowed(UUID followerId, UUID followeeId) {
        return userFollowed(UUID.randomUUID(), followerId, followeeId);
    }

    public WarehouseEvent userFollowed(UUID eventId, UUID followerId, UUID followeeId) {
        return event(eventId, "user.followed", followeeId.toString(), followerId, "follow",
                followerId + ":" + followeeId,
                Map.of("followerId", followerId.toString(), "followeeId", followeeId.toString()));
    }

    public WarehouseEvent userUnfollowed(UUID followerId, UUID followeeId) {
        return userUnfollowed(UUID.randomUUID(), followerId, followeeId);
    }

    public WarehouseEvent userUnfollowed(UUID eventId, UUID followerId, UUID followeeId) {
        return event(eventId, "user.unfollowed", followeeId.toString(), followerId, "follow",
                followerId + ":" + followeeId,
                Map.of("followerId", followerId.toString(), "followeeId", followeeId.toString()));
    }

    public WarehouseEvent postHidden(UUID userId, UUID postId) {
        return postHidden(UUID.randomUUID(), userId, postId);
    }

    public WarehouseEvent postHidden(UUID eventId, UUID userId, UUID postId) {
        return event(eventId, "post.hidden", postId.toString(), userId, "post_hide", userId + ":" + postId,
                Map.of("postId", postId.toString(), "userId", userId.toString()));
    }

    public WarehouseEvent postUnhidden(UUID userId, UUID postId) {
        return postUnhidden(UUID.randomUUID(), userId, postId);
    }

    public WarehouseEvent postUnhidden(UUID eventId, UUID userId, UUID postId) {
        return event(eventId, "post.unhidden", postId.toString(), userId, "post_hide", userId + ":" + postId,
                Map.of("postId", postId.toString(), "userId", userId.toString()));
    }

    public TransactWriteItem put(WarehouseEvent event) {
        Map<String, AttributeValue> item = new HashMap<>();
        item.put("pk", AttributeValue.fromS("EVENT#" + event.eventId()));
        item.put("eventId", AttributeValue.fromS(event.eventId().toString()));
        item.put("eventType", AttributeValue.fromS(event.eventType()));
        item.put("eventVersion", AttributeValue.fromS(event.eventVersion()));
        item.put("partitionKey", AttributeValue.fromS(event.partitionKey()));
        item.put("occurredAt", AttributeValue.fromS(event.occurredAt().toString()));
        item.put("producer", AttributeValue.fromS(event.producer()));
        item.put("pendingShard", AttributeValue.fromS(shard(event.partitionKey())));
        item.put("availableAt", AttributeValue.fromS(event.occurredAt().toString()));
        item.put("attempts", AttributeValue.fromN("0"));
        putNullable(item, "actorId", event.actorId() == null ? null : event.actorId().toString());
        putNullable(item, "entityType", event.entityType());
        putNullable(item, "entityId", event.entityId());
        putNullable(item, "correlationId", event.correlationId());
        putNullable(item, "sessionId", event.sessionId() == null ? null : event.sessionId().toString());
        putNullable(item, "requestId", event.requestId() == null ? null : event.requestId().toString());
        putNullable(item, "experimentId", event.experimentId());
        putNullable(item, "experimentVariant", event.experimentVariant());
        if (event.entityVersion() != null) {
            item.put("entityVersion", AttributeValue.fromN(event.entityVersion().toString()));
        }
        try {
            item.put("payload", AttributeValue.fromS(objectMapper.writeValueAsString(event.payload())));
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Warehouse event payload is not JSON serializable", e);
        }

        return TransactWriteItem.builder().put(Put.builder()
                .tableName(tableName)
                .item(item)
                .conditionExpression("attribute_not_exists(pk)")
                .build()).build();
    }

    public void recordEnqueued(String eventType) {
        if (emfMetrics != null) {
            emfMetrics.increment("dynamodb_warehouse_outbox_enqueued_total", Map.of("eventType", eventType));
        }
    }

    private WarehouseEvent event(String type, String partitionKey, UUID actorId, String entityType,
            String entityId, Map<String, Object> payload) {
        return event(UUID.randomUUID(), type, partitionKey, actorId, entityType, entityId, payload);
    }

    private WarehouseEvent event(UUID eventId, String type, String partitionKey, UUID actorId,
            String entityType, String entityId, Map<String, Object> payload) {
        // Wall-clock version: millis since epoch increases on each authoritative
        // state change including reversals (like→unlike→relike), enabling
        // downstream ordering by (entityId, entityVersion) without a separate
        // version record. Clock adjustments could theoretically regress; a
        // strict per-entity counter record is future work if reordered
        // transitions across hosts are observed. See DATA_ANALYSIS_AND_FEED_DESIGN §4.1.
        long entityVersion = Instant.now().toEpochMilli();
        return new WarehouseEvent(eventId, type, "2", partitionKey, Instant.now(), "backend",
                actorId, entityType, entityId, entityVersion, MDC.get(CorrelationIdFilter.MDC_KEY),
                null, null, null, null, payload);
    }

    private String shard(String partitionKey) {
        return "PENDING#" + String.format("%02d", Math.floorMod(partitionKey.hashCode(), SHARD_COUNT));
    }

    private void putNullable(Map<String, AttributeValue> item, String name, String value) {
        if (value != null) {
            item.put(name, AttributeValue.fromS(value));
        }
    }
}
