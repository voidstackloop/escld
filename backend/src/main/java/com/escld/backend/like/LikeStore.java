package com.escld.backend.like;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.BatchGetItemRequest;
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException;
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest;
import software.amazon.awssdk.services.dynamodb.model.KeysAndAttributes;
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest;
import software.amazon.awssdk.services.dynamodb.model.QueryRequest;
import software.amazon.awssdk.services.dynamodb.model.ReturnValue;
import software.amazon.awssdk.services.dynamodb.model.Put;
import software.amazon.awssdk.services.dynamodb.model.Delete;
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItem;
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsRequest;
import software.amazon.awssdk.services.dynamodb.model.TransactionCanceledException;

import com.escld.backend.warehouse.DynamoWarehouseOutbox;

import lombok.extern.slf4j.Slf4j;

/**
 * Adjacency-list post likes in DynamoDB, same shape as FollowGraphStore: one
 * edge written under both the post's and the liker's partitions so "does
 * user X like post Y" and "which of these posts has X liked" are each
 * single-item/single-request reads, not a Postgres join.
 *
 * The like *count* itself deliberately stays a denormalized counter on the
 * Postgres `posts` row (see PostRepository#incrementLikeCount/
 * decrementLikeCount) — the same split already used for
 * users.followers_count vs. the DynamoDB follows table, so this introduces
 * no new consistency trade-off beyond one already accepted in this codebase.
 */
@Slf4j
@Component
public class LikeStore {

    private static final String LIKE_PREFIX = "LIKE#";
    private static final String LIKED_PREFIX = "LIKED#";
    private static final String RECENCY_INDEX_NAME = "byUserRecency";

    private final DynamoDbClient dynamoDbClient;
    private final String tableName;
    private final DynamoWarehouseOutbox warehouseOutbox;

    @Autowired
    public LikeStore(DynamoDbClient dynamoDbClient, @Value("${app.dynamodb.likes-table-name}") String tableName,
            DynamoWarehouseOutbox warehouseOutbox) {
        this.dynamoDbClient = dynamoDbClient;
        this.tableName = tableName;
        this.warehouseOutbox = warehouseOutbox;
    }

    /** Retained for focused store tests that do not construct the full application graph. */
    public LikeStore(DynamoDbClient dynamoDbClient, String tableName) {
        this(dynamoDbClient, tableName, null);
    }

    /** Returns true if this call newly created the like (false if already liked - idempotent). */
    public boolean like(UUID postId, UUID userId) {
        return like(postId, userId, UUID.randomUUID());
    }

    /** Same as {@link #like(UUID, UUID)} but reuses the caller's stable eventId
     * so the DynamoDB edge, its outbox event, and the Postgres counter receipt
     * share one idempotency key across retries and replays. */
    public boolean like(UUID postId, UUID userId, UUID eventId) {
        String now = Instant.now().toString();
        if (warehouseOutbox != null) {
            return likeWithTransactionalOutbox(postId, userId, eventId, now);
        }
        try {
            dynamoDbClient.putItem(PutItemRequest.builder()
                    .tableName(tableName)
                    .item(item(postKey(postId), LIKE_PREFIX + userId, now))
                    .conditionExpression("attribute_not_exists(pk)")
                    .build());
        } catch (ConditionalCheckFailedException alreadyLiked) {
            // Expected idempotent race (a double-tap, a retried request), not
            // an error — debug, not warn. Previously left zero trace at all.
            log.debug("Post {} already liked by user {} (idempotent no-op)", postId, userId);
            return false;
        }

        dynamoDbClient.putItem(PutItemRequest.builder()
                .tableName(tableName)
                .item(item(userKey(userId), LIKED_PREFIX + postId, now))
                .build());
        return true;
    }

    private boolean likeWithTransactionalOutbox(UUID postId, UUID userId, UUID eventId, String now) {
        var event = warehouseOutbox.postLiked(eventId, postId, userId);
        long version = event.entityVersion() == null ? Instant.now().toEpochMilli() : event.entityVersion();
        // Deliberately NOT "OR entityVersion < :newVersion" — version() is
        // always Instant.now().toEpochMilli() (see WarehouseEvent's
        // constructor), strictly increasing on every call regardless of
        // eventId, so an "allow a newer version through" clause here would
        // let ANY duplicate/retried like() overwrite an already-live edge
        // and incorrectly return true instead of the idempotent false a
        // caller (and this class's own javadoc) promises. attribute_not_
        // exists(pk) OR deleted = :true is the complete, correct condition:
        // succeed when never liked, or when a prior unlike tombstoned it —
        // an already-live like must always fail this check and fall through
        // to the isLiked()-checked idempotent-no-op path below.
        var primaryEdge = Put.builder()
                .tableName(tableName)
                .item(liveItem(postKey(postId), LIKE_PREFIX + userId, now, version))
                .conditionExpression("attribute_not_exists(pk) OR deleted = :true")
                .expressionAttributeValues(Map.of(":true", AttributeValue.fromBool(true)))
                .build();
        var reverseEdge = Put.builder()
                .tableName(tableName)
                .item(liveItem(userKey(userId), LIKED_PREFIX + postId, now, version))
                .conditionExpression("attribute_not_exists(pk) OR deleted = :true")
                .expressionAttributeValues(Map.of(":true", AttributeValue.fromBool(true)))
                .build();
        try {
            dynamoDbClient.transactWriteItems(TransactWriteItemsRequest.builder()
                    .transactItems(
                            TransactWriteItem.builder().put(primaryEdge).build(),
                            TransactWriteItem.builder().put(reverseEdge).build(),
                            warehouseOutbox.put(event))
                    .build());
            warehouseOutbox.recordEnqueued(event.eventType());
            return true;
        } catch (TransactionCanceledException canceled) {
            // A duplicate/retried like loses the conditional race on the
            // authoritative POST# edge. Re-read that edge to distinguish the
            // expected idempotent case from a capacity or transaction error.
            if (isLiked(postId, userId)) {
                log.debug("Post {} already liked by user {} (idempotent no-op)", postId, userId);
                return false;
            }
            throw canceled;
        }
    }

    /** Returns true if this call removed an existing like (false if it was never liked - idempotent). */
    public boolean unlike(UUID postId, UUID userId) {
        return unlike(postId, userId, UUID.randomUUID());
    }

    public boolean unlike(UUID postId, UUID userId, UUID eventId) {
        if (warehouseOutbox != null) {
            return unlikeWithTransactionalOutbox(postId, userId, eventId);
        }
        var response = dynamoDbClient.deleteItem(DeleteItemRequest.builder()
                .tableName(tableName)
                .key(key(postKey(postId), LIKE_PREFIX + userId))
                .returnValues(ReturnValue.ALL_OLD)
                .build());
        if (!response.hasAttributes()) {
            return false;
        }

        dynamoDbClient.deleteItem(DeleteItemRequest.builder()
                .tableName(tableName)
                .key(key(userKey(userId), LIKED_PREFIX + postId))
                .build());
        return true;
    }

    private boolean unlikeWithTransactionalOutbox(UUID postId, UUID userId, UUID eventId) {
        var event = warehouseOutbox.postUnliked(eventId, postId, userId);
        long version = event.entityVersion() == null ? Instant.now().toEpochMilli() : event.entityVersion();
        String now = Instant.now().toString();
        try {
            dynamoDbClient.transactWriteItems(TransactWriteItemsRequest.builder().transactItems(
                    TransactWriteItem.builder().put(Put.builder()
                            .tableName(tableName)
                            .item(tombstoneItem(postKey(postId), LIKE_PREFIX + userId, now, version))
                            .conditionExpression("attribute_exists(pk) AND (attribute_not_exists(entityVersion) OR entityVersion < :newVersion)")
                            .expressionAttributeValues(Map.of(
                                    ":newVersion", AttributeValue.fromN(Long.toString(version))))
                            .build()).build(),
                    TransactWriteItem.builder().put(Put.builder()
                            .tableName(tableName)
                            .item(tombstoneItem(userKey(userId), LIKED_PREFIX + postId, now, version))
                            .conditionExpression("attribute_exists(pk) AND (attribute_not_exists(entityVersion) OR entityVersion < :newVersion)")
                            .expressionAttributeValues(Map.of(
                                    ":newVersion", AttributeValue.fromN(Long.toString(version))))
                            .build()).build(),
                    warehouseOutbox.put(event)).build());
            warehouseOutbox.recordEnqueued(event.eventType());
            return true;
        } catch (TransactionCanceledException canceled) {
            if (!isLiked(postId, userId)) {
                log.debug("Post {} already unliked by user {} (idempotent no-op)", postId, userId);
                return false;
            }
            throw canceled;
        }
    }

    /** Single BatchGetItem round trip rather than N sequential reads for a page of posts. */
    public Set<UUID> getLikedPostIds(UUID userId, List<UUID> postIds) {
        if (postIds.isEmpty()) {
            return Set.of();
        }

        List<Map<String, AttributeValue>> keys = postIds.stream()
                .map(postId -> key(postKey(postId), LIKE_PREFIX + userId))
                .collect(Collectors.toList());

        var response = dynamoDbClient.batchGetItem(BatchGetItemRequest.builder()
                .requestItems(Map.of(tableName, KeysAndAttributes.builder().keys(keys).build()))
                .build());

        return response.responses().getOrDefault(tableName, List.of()).stream()
                .filter(itm -> !isDeleted(itm))
                .map(itm -> UUID.fromString(itm.get("pk").s().substring("POST#".length())))
                .collect(Collectors.toSet());
    }

    /** Single-partition query of every post this user has liked — the
     * `LIKED#` items under their own partition. Used for account deletion
     * (see AccountDeletionService); not needed by the normal like/unlike
     * request path, which only ever checks a known candidate list via
     * getLikedPostIds. */
    public List<UUID> listLikedPostIds(UUID userId) {
        var response = dynamoDbClient.query(QueryRequest.builder()
                .tableName(tableName)
                .keyConditionExpression("pk = :pk AND begins_with(sk, :skPrefix)")
                .expressionAttributeValues(Map.of(
                        ":pk", AttributeValue.fromS(userKey(userId)),
                        ":skPrefix", AttributeValue.fromS(LIKED_PREFIX)))
                .build());

        return response.items().stream()
                .filter(itm -> !isDeleted(itm))
                .map(itm -> UUID.fromString(itm.get("sk").s().substring(LIKED_PREFIX.length())))
                .collect(Collectors.toList());
    }

    /**
     * The viewer's genuinely most-recently-liked posts, for feed-ranking
     * personalization (see FeedServiceImpl) — NOT the same as listLikedPostIds
     * above. That method's sk (LIKED#&lt;postId&gt;) isn't date-ordered, so a
     * plain Limit() on it would return an arbitrary, permanently-frozen
     * subset rather than a recent-N window. This queries the byUserRecency
     * GSI instead (see infra/lib/likes-stack.ts), whose sort key is the
     * createdAt attribute every like item already writes, so
     * scanIndexForward(false) + limit genuinely means "most recent."
     */
    public List<UUID> listRecentLikedPostIds(UUID userId, int limit) {
        var response = dynamoDbClient.query(QueryRequest.builder()
                .tableName(tableName)
                .indexName(RECENCY_INDEX_NAME)
                .keyConditionExpression("pk = :pk")
                .expressionAttributeValues(Map.of(":pk", AttributeValue.fromS(userKey(userId))))
                .scanIndexForward(false)
                .limit(limit)
                .build());

        // Client-side tombstone filter: byUserRecency GSI is KEYS_ONLY so
        // deleted/entityVersion are not projected; server-side filtering
        // requires a GSI recreation to INCLUDE. Over-fetch is bounded by limit.
        return response.items().stream()
                .filter(itm -> !isDeleted(itm))
                .map(itm -> UUID.fromString(itm.get("sk").s().substring(LIKED_PREFIX.length())))
                .collect(Collectors.toList());
    }

    /**
     * Removes every like this user has made, as part of account deletion.
     * Deliberately does NOT remove other users' likes on this user's own
     * posts (pk=POST#<postId>, sk=LIKE#<otherUserId>) — that's other users'
     * engagement data, not this user's, and it becomes harmless once the
     * post itself is soft-deleted (see AccountDeletionService).
     */
    public void unlikeAll(UUID userId) {
        for (UUID postId : listLikedPostIds(userId)) {
            unlike(postId, userId);
        }
    }

    private Map<String, AttributeValue> item(String pk, String sk, String createdAt) {
        return liveItem(pk, sk, createdAt, Instant.now().toEpochMilli());
    }

    private Map<String, AttributeValue> liveItem(String pk, String sk, String createdAt, long version) {
        Map<String, AttributeValue> m = new java.util.HashMap<>();
        m.put("pk", AttributeValue.fromS(pk));
        m.put("sk", AttributeValue.fromS(sk));
        m.put("createdAt", AttributeValue.fromS(createdAt));
        m.put("updatedAt", AttributeValue.fromS(createdAt));
        m.put("deleted", AttributeValue.fromBool(false));
        m.put("entityVersion", AttributeValue.fromN(Long.toString(version)));
        return m;
    }

    private Map<String, AttributeValue> tombstoneItem(String pk, String sk, String now, long version) {
        Map<String, AttributeValue> m = new java.util.HashMap<>();
        m.put("pk", AttributeValue.fromS(pk));
        m.put("sk", AttributeValue.fromS(sk));
        m.put("createdAt", AttributeValue.fromS(now));
        m.put("updatedAt", AttributeValue.fromS(now));
        m.put("deletedAt", AttributeValue.fromS(now));
        m.put("deleted", AttributeValue.fromBool(true));
        m.put("entityVersion", AttributeValue.fromN(Long.toString(version)));
        return m;
    }

    private boolean isDeleted(Map<String, AttributeValue> item) {
        return item.containsKey("deleted") && Boolean.TRUE.equals(item.get("deleted").bool());
    }

    private Map<String, AttributeValue> key(String pk, String sk) {
        return Map.of("pk", AttributeValue.fromS(pk), "sk", AttributeValue.fromS(sk));
    }

    private boolean isLiked(UUID postId, UUID userId) {
        var response = dynamoDbClient.getItem(builder -> builder.tableName(tableName)
                .key(key(postKey(postId), LIKE_PREFIX + userId))
                .consistentRead(true));
        return response.hasItem() && !isDeleted(response.item());
    }

    private String postKey(UUID postId) {
        return "POST#" + postId;
    }

    private String userKey(UUID userId) {
        return "USER#" + userId;
    }
}
