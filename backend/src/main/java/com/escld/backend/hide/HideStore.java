package com.escld.backend.hide;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import com.escld.backend.warehouse.DynamoWarehouseOutbox;

import lombok.extern.slf4j.Slf4j;

import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.BatchGetItemRequest;
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest;
import software.amazon.awssdk.services.dynamodb.model.KeysAndAttributes;
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest;
import software.amazon.awssdk.services.dynamodb.model.QueryRequest;
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest;
import software.amazon.awssdk.services.dynamodb.model.Put;
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItem;
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsRequest;
import software.amazon.awssdk.services.dynamodb.model.TransactionCanceledException;

/**
 * A viewer's own "not interested" / hide decisions on posts — see
 * infra/lib/post-hides-stack.ts for the table's own doc on why this is
 * single-partition-per-user with no reverse edge, unlike LikeStore. This is
 * the feed's first genuine negative signal (see FeedServiceImpl's own doc
 * comment on why every prior signal was purely positive/absent, never
 * negative) — a hidden post is filtered out of the viewer's own feed
 * entirely (FeedServiceImpl#getFeed), not merely ranked lower.
 */
@Component
@Slf4j
public class HideStore {

    private static final String HIDDEN_PREFIX = "HIDDEN#";

    private final DynamoDbClient dynamoDbClient;
    private final String tableName;
    private final DynamoWarehouseOutbox warehouseOutbox;

    @Autowired
    public HideStore(DynamoDbClient dynamoDbClient,
            @Value("${app.dynamodb.post-hides-table-name}") String tableName,
            DynamoWarehouseOutbox warehouseOutbox) {
        this.dynamoDbClient = dynamoDbClient;
        this.tableName = tableName;
        this.warehouseOutbox = warehouseOutbox;
    }

    public HideStore(DynamoDbClient dynamoDbClient, String tableName) {
        this(dynamoDbClient, tableName, null);
    }

    /** Idempotent — no conditional check needed since, unlike a like, hiding
     * has no counter or reciprocal side effect for a repeat write to race on. */
    public void hide(UUID userId, UUID postId) {
        hide(userId, postId, UUID.randomUUID());
    }

    public void hide(UUID userId, UUID postId, UUID eventId) {
        if (warehouseOutbox != null) {
            var event = warehouseOutbox.postHidden(eventId, userId, postId);
            long version = event.entityVersion() == null ? Instant.now().toEpochMilli() : event.entityVersion();
            String now = Instant.now().toString();
            try {
                dynamoDbClient.transactWriteItems(TransactWriteItemsRequest.builder().transactItems(
                        TransactWriteItem.builder().put(Put.builder()
                                .tableName(tableName)
                                .item(liveItem(userId, postId, now, version))
                                .conditionExpression("attribute_not_exists(pk) OR deleted = :true OR entityVersion < :newVersion")
                                .expressionAttributeValues(Map.of(
                                        ":true", AttributeValue.fromBool(true),
                                        ":newVersion", AttributeValue.fromN(Long.toString(version))))
                                .build()).build(),
                        warehouseOutbox.put(event)).build());
                warehouseOutbox.recordEnqueued(event.eventType());
            } catch (TransactionCanceledException canceled) {
                if (isHidden(userId, postId)) {
                    log.debug("Post {} already hidden by user {} (idempotent no-op)", postId, userId);
                    return;
                }
                throw canceled;
            }
            return;
        }
        dynamoDbClient.putItem(PutItemRequest.builder()
                .tableName(tableName)
                .item(hideItem(userId, postId))
                .build());
    }

    public void unhide(UUID userId, UUID postId) {
        unhide(userId, postId, UUID.randomUUID());
    }

    public void unhide(UUID userId, UUID postId, UUID eventId) {
        if (warehouseOutbox != null) {
            var event = warehouseOutbox.postUnhidden(eventId, userId, postId);
            long version = event.entityVersion() == null ? Instant.now().toEpochMilli() : event.entityVersion();
            String now = Instant.now().toString();
            try {
                dynamoDbClient.transactWriteItems(TransactWriteItemsRequest.builder().transactItems(
                        TransactWriteItem.builder().put(Put.builder()
                                .tableName(tableName)
                                .item(tombstoneItem(userId, postId, now, version))
                                .conditionExpression("attribute_exists(pk) AND (attribute_not_exists(entityVersion) OR entityVersion < :newVersion)")
                                .expressionAttributeValues(Map.of(
                                        ":newVersion", AttributeValue.fromN(Long.toString(version))))
                                .build()).build(),
                        warehouseOutbox.put(event)).build());
                warehouseOutbox.recordEnqueued(event.eventType());
            } catch (TransactionCanceledException canceled) {
                if (!isHidden(userId, postId)) {
                    log.debug("Post {} was already unhidden for user {} (idempotent no-op)", postId, userId);
                    return;
                }
                throw canceled;
            }
            return;
        }
        dynamoDbClient.deleteItem(DeleteItemRequest.builder()
                .tableName(tableName)
                .key(hideKey(userId, postId))
                .build());
    }

    /** Single BatchGetItem round trip against a bounded candidate list —
     * mirrors LikeStore#getLikedPostIds exactly, and for the same reason:
     * FeedServiceImpl only ever needs to know which of *this page's*
     * candidates are hidden, never a full per-user listing (which would grow
     * unboundedly for an active hider and doesn't fit any real query need). */
    public Set<UUID> getHiddenPostIds(UUID userId, List<UUID> postIds) {
        if (postIds.isEmpty()) {
            return Set.of();
        }

        List<Map<String, AttributeValue>> keys = postIds.stream()
                .map(postId -> Map.of(
                        "pk", AttributeValue.fromS(userKey(userId)),
                        "sk", AttributeValue.fromS(HIDDEN_PREFIX + postId)))
                .collect(Collectors.toList());

        var response = dynamoDbClient.batchGetItem(BatchGetItemRequest.builder()
                .requestItems(Map.of(tableName, KeysAndAttributes.builder().keys(keys).build()))
                .build());

        return response.responses().getOrDefault(tableName, List.of()).stream()
                .filter(item -> !isDeleted(item))
                .map(item -> UUID.fromString(item.get("sk").s().substring(HIDDEN_PREFIX.length())))
                .collect(Collectors.toSet());
    }

    /** Full per-user listing — used only by account deletion (see
     * AccountDeletionService), which needs to remove every hide this user
     * made as part of cleaning up their own data, not by the normal
     * hide/unhide/feed-filter request paths above. */
    public List<UUID> listHiddenPostIds(UUID userId) {
        var response = dynamoDbClient.query(QueryRequest.builder()
                .tableName(tableName)
                .keyConditionExpression("pk = :pk AND begins_with(sk, :skPrefix)")
                .expressionAttributeValues(Map.of(
                        ":pk", AttributeValue.fromS(userKey(userId)),
                        ":skPrefix", AttributeValue.fromS(HIDDEN_PREFIX)))
                .build());

        return response.items().stream()
                .filter(item -> !isDeleted(item))
                .map(item -> UUID.fromString(item.get("sk").s().substring(HIDDEN_PREFIX.length())))
                .collect(Collectors.toList());
    }

    public void unhideAll(UUID userId) {
        for (UUID postId : listHiddenPostIds(userId)) {
            // Account deletion is data cleanup, not a restored-preference
            // signal. Avoid producing misleading unhide training events.
            dynamoDbClient.deleteItem(DeleteItemRequest.builder()
                    .tableName(tableName)
                    .key(hideKey(userId, postId))
                    .build());
        }
    }

    private boolean isHidden(UUID userId, UUID postId) {
        var item = dynamoDbClient.getItem(GetItemRequest.builder()
                .tableName(tableName)
                .key(hideKey(userId, postId))
                .consistentRead(true)
                .build());
        return item.hasItem() && !isDeleted(item.item());
    }

    private boolean isDeleted(Map<String, AttributeValue> item) {
        return item != null && item.containsKey("deleted") && Boolean.TRUE.equals(item.get("deleted").bool());
    }

    private Map<String, AttributeValue> liveItem(UUID userId, UUID postId, String now, long version) {
        Map<String, AttributeValue> m = new java.util.HashMap<>();
        m.put("pk", AttributeValue.fromS(userKey(userId)));
        m.put("sk", AttributeValue.fromS(HIDDEN_PREFIX + postId));
        m.put("createdAt", AttributeValue.fromS(now));
        m.put("updatedAt", AttributeValue.fromS(now));
        m.put("deleted", AttributeValue.fromBool(false));
        m.put("entityVersion", AttributeValue.fromN(Long.toString(version)));
        return m;
    }

    private Map<String, AttributeValue> tombstoneItem(UUID userId, UUID postId, String now, long version) {
        Map<String, AttributeValue> m = new java.util.HashMap<>();
        m.put("pk", AttributeValue.fromS(userKey(userId)));
        m.put("sk", AttributeValue.fromS(HIDDEN_PREFIX + postId));
        m.put("createdAt", AttributeValue.fromS(now));
        m.put("updatedAt", AttributeValue.fromS(now));
        m.put("deletedAt", AttributeValue.fromS(now));
        m.put("deleted", AttributeValue.fromBool(true));
        m.put("entityVersion", AttributeValue.fromN(Long.toString(version)));
        return m;
    }

    private Map<String, AttributeValue> hideItem(UUID userId, UUID postId) {
        return Map.of(
                "pk", AttributeValue.fromS(userKey(userId)),
                "sk", AttributeValue.fromS(HIDDEN_PREFIX + postId),
                "createdAt", AttributeValue.fromS(Instant.now().toString()));
    }

    private Map<String, AttributeValue> hideKey(UUID userId, UUID postId) {
        return Map.of(
                "pk", AttributeValue.fromS(userKey(userId)),
                "sk", AttributeValue.fromS(HIDDEN_PREFIX + postId));
    }

    private String userKey(UUID userId) {
        return "USER#" + userId;
    }
}
