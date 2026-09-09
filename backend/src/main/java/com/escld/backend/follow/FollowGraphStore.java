package com.escld.backend.follow;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest;
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest;
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest;
import software.amazon.awssdk.services.dynamodb.model.QueryRequest;
import software.amazon.awssdk.services.dynamodb.model.Put;
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItem;
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsRequest;
import software.amazon.awssdk.services.dynamodb.model.TransactionCanceledException;

import com.escld.backend.warehouse.DynamoWarehouseOutbox;

/**
 * Adjacency-list social graph in DynamoDB: one item per follow edge, written
 * under BOTH users' partitions so "who does X follow" and "who follows X"
 * are each a single-partition query, not a scan. Trades 2x writes for O(1)
 * reads in both directions — the right trade for a read-heavy social graph.
 *
 * Pending follow requests (private accounts) are a separate item shape —
 * REQUEST# — written only under the target's partition, so "who wants to
 * follow me" is also a single-partition query. They never become FOLLOWING#/
 * FOLLOWER# items until accepted.
 */
@Component
public class FollowGraphStore {

    private static final String FOLLOWING_PREFIX = "FOLLOWING#";
    private static final String FOLLOWER_PREFIX = "FOLLOWER#";
    private static final String REQUEST_PREFIX = "REQUEST#";

    private final DynamoDbClient dynamoDbClient;
    private final String tableName;
    private final DynamoWarehouseOutbox warehouseOutbox;

    @Autowired
    public FollowGraphStore(DynamoDbClient dynamoDbClient, @Value("${app.dynamodb.table-name}") String tableName,
            DynamoWarehouseOutbox warehouseOutbox) {
        this.dynamoDbClient = dynamoDbClient;
        this.tableName = tableName;
        this.warehouseOutbox = warehouseOutbox;
    }

    public FollowGraphStore(DynamoDbClient dynamoDbClient, String tableName) {
        this(dynamoDbClient, tableName, null);
    }

    /** Returns true only when this call creates a new edge. */
    public boolean follow(UUID followerId, UUID followeeId) {
        return follow(followerId, followeeId, UUID.randomUUID());
    }

    /** Same as {@link #follow(UUID, UUID)} with caller-supplied stable eventId
     * for idempotent counter projections. */
    public boolean follow(UUID followerId, UUID followeeId, UUID eventId) {
        String now = Instant.now().toString();

        if (warehouseOutbox != null) {
            var event = warehouseOutbox.userFollowed(eventId, followerId, followeeId);
            long version = event.entityVersion() == null ? Instant.now().toEpochMilli() : event.entityVersion();
            try {
                dynamoDbClient.transactWriteItems(TransactWriteItemsRequest.builder().transactItems(
                        TransactWriteItem.builder().put(Put.builder().tableName(tableName)
                                .item(liveItem(userKey(followerId), FOLLOWING_PREFIX + followeeId, now, version))
                                .conditionExpression("attribute_not_exists(pk) OR deleted = :true OR entityVersion < :newVersion")
                                .expressionAttributeValues(Map.of(
                                        ":true", AttributeValue.fromBool(true),
                                        ":newVersion", AttributeValue.fromN(Long.toString(version))))
                                .build()).build(),
                        TransactWriteItem.builder().put(Put.builder().tableName(tableName)
                                .item(liveItem(userKey(followeeId), FOLLOWER_PREFIX + followerId, now, version))
                                .conditionExpression("attribute_not_exists(pk) OR deleted = :true OR entityVersion < :newVersion")
                                .expressionAttributeValues(Map.of(
                                        ":true", AttributeValue.fromBool(true),
                                        ":newVersion", AttributeValue.fromN(Long.toString(version))))
                                .build()).build(),
                        warehouseOutbox.put(event)).build());
                warehouseOutbox.recordEnqueued(event.eventType());
                return true;
            } catch (TransactionCanceledException canceled) {
                if (isFollowing(followerId, followeeId)) return false;
                throw canceled;
            }
        }

        dynamoDbClient.putItem(PutItemRequest.builder()
                .tableName(tableName)
                .item(item(userKey(followerId), FOLLOWING_PREFIX + followeeId, now))
                .build());

        dynamoDbClient.putItem(PutItemRequest.builder()
                .tableName(tableName)
                .item(item(userKey(followeeId), FOLLOWER_PREFIX + followerId, now))
                .build());
        return true;
    }

    /** Returns true only when this call removes an existing edge. */
    public boolean unfollow(UUID followerId, UUID followeeId) {
        return unfollow(followerId, followeeId, UUID.randomUUID());
    }

    public boolean unfollow(UUID followerId, UUID followeeId, UUID eventId) {
        if (warehouseOutbox != null) {
            var event = warehouseOutbox.userUnfollowed(eventId, followerId, followeeId);
            long version = event.entityVersion() == null ? Instant.now().toEpochMilli() : event.entityVersion();
            String now = Instant.now().toString();
            try {
                dynamoDbClient.transactWriteItems(TransactWriteItemsRequest.builder().transactItems(
                        TransactWriteItem.builder().put(Put.builder().tableName(tableName)
                                .item(tombstoneItem(userKey(followerId), FOLLOWING_PREFIX + followeeId, now, version))
                                .conditionExpression("attribute_exists(pk) AND (attribute_not_exists(entityVersion) OR entityVersion < :newVersion)")
                                .expressionAttributeValues(Map.of(
                                        ":newVersion", AttributeValue.fromN(Long.toString(version))))
                                .build()).build(),
                        TransactWriteItem.builder().put(Put.builder().tableName(tableName)
                                .item(tombstoneItem(userKey(followeeId), FOLLOWER_PREFIX + followerId, now, version))
                                .conditionExpression("attribute_exists(pk) AND (attribute_not_exists(entityVersion) OR entityVersion < :newVersion)")
                                .expressionAttributeValues(Map.of(
                                        ":newVersion", AttributeValue.fromN(Long.toString(version))))
                                .build()).build(),
                        warehouseOutbox.put(event)).build());
                warehouseOutbox.recordEnqueued(event.eventType());
                return true;
            } catch (TransactionCanceledException canceled) {
                if (!isFollowing(followerId, followeeId)) return false;
                throw canceled;
            }
        }
        dynamoDbClient.deleteItem(DeleteItemRequest.builder()
                .tableName(tableName)
                .key(key(userKey(followerId), FOLLOWING_PREFIX + followeeId))
                .build());

        dynamoDbClient.deleteItem(DeleteItemRequest.builder()
                .tableName(tableName)
                .key(key(userKey(followeeId), FOLLOWER_PREFIX + followerId))
                .build());
        return true;
    }

    public boolean isFollowing(UUID followerId, UUID followeeId) {
        var response = dynamoDbClient.getItem(GetItemRequest.builder()
                .tableName(tableName)
                .key(key(userKey(followerId), FOLLOWING_PREFIX + followeeId))
                .build());
        return response.hasItem() && !isDeleted(response.item());
    }

    public List<UUID> listFollowing(UUID userId) {
        return queryIds(userId, FOLLOWING_PREFIX);
    }

    /**
     * Same edges as listFollowing, but also surfaces when each follow
     * happened — every FOLLOWING# item already writes createdAt (see item()
     * below), it's just discarded by queryIds. Needed for feed ranking's
     * "recently followed" signal (see FeedServiceImpl); kept as a separate
     * method rather than changing listFollowing's return type, since every
     * other caller (FollowServiceImpl, AccountDeletionServiceImpl,
     * unfollowAll below) only ever needs the bare ids.
     */
    public Map<UUID, Instant> listFollowingWithRecency(UUID userId) {
        var response = dynamoDbClient.query(QueryRequest.builder()
                .tableName(tableName)
                .keyConditionExpression("pk = :pk AND begins_with(sk, :skPrefix)")
                .expressionAttributeValues(Map.of(
                        ":pk", AttributeValue.fromS(userKey(userId)),
                        ":skPrefix", AttributeValue.fromS(FOLLOWING_PREFIX)))
                .build());

        Map<UUID, Instant> result = new HashMap<>();
        for (Map<String, AttributeValue> item : response.items()) {
            if (isDeleted(item)) continue;
            UUID followeeId = UUID.fromString(item.get("sk").s().substring(FOLLOWING_PREFIX.length()));
            result.put(followeeId, Instant.parse(item.get("createdAt").s()));
        }
        return result;
    }

    public List<UUID> listFollowers(UUID userId) {
        return queryIds(userId, FOLLOWER_PREFIX);
    }

    public void createRequest(UUID followerId, UUID followeeId) {
        dynamoDbClient.putItem(PutItemRequest.builder()
                .tableName(tableName)
                .item(item(userKey(followeeId), REQUEST_PREFIX + followerId, Instant.now().toString()))
                .build());
    }

    public void deleteRequest(UUID followerId, UUID followeeId) {
        dynamoDbClient.deleteItem(DeleteItemRequest.builder()
                .tableName(tableName)
                .key(key(userKey(followeeId), REQUEST_PREFIX + followerId))
                .build());
    }

    public boolean hasPendingRequest(UUID followerId, UUID followeeId) {
        var response = dynamoDbClient.getItem(GetItemRequest.builder()
                .tableName(tableName)
                .key(key(userKey(followeeId), REQUEST_PREFIX + followerId))
                .build());
        return response.hasItem();
    }

    public List<UUID> listPendingRequests(UUID followeeId) {
        return queryIds(followeeId, REQUEST_PREFIX);
    }

    /**
     * Removes every edge this user participates in as part of account
     * deletion: both directions of every follow, and every pending request
     * where they're the target. Known gap, accepted for this "minimal
     * capability" scope (see the enterprise-hardening plan): a pending
     * request this user *sent* to someone else can't be found here — REQUEST#
     * items are only queryable from the target's partition, and there's no
     * reverse index on the requester. A stale request referencing a deleted
     * user is harmless (it just never gets accepted), not a correctness bug.
     */
    public void unfollowAll(UUID userId) {
        for (UUID followeeId : listFollowing(userId)) {
            unfollow(userId, followeeId);
        }
        for (UUID followerId : listFollowers(userId)) {
            unfollow(followerId, userId);
        }
        for (UUID requesterId : listPendingRequests(userId)) {
            deleteRequest(requesterId, userId);
        }
    }

    private List<UUID> queryIds(UUID userId, String skPrefix) {
        var response = dynamoDbClient.query(QueryRequest.builder()
                .tableName(tableName)
                .keyConditionExpression("pk = :pk AND begins_with(sk, :skPrefix)")
                .expressionAttributeValues(Map.of(
                        ":pk", AttributeValue.fromS(userKey(userId)),
                        ":skPrefix", AttributeValue.fromS(skPrefix)))
                .build());

        return response.items().stream()
                .filter(itm -> !isDeleted(itm))
                .map(itm -> UUID.fromString(itm.get("sk").s().substring(skPrefix.length())))
                .collect(Collectors.toList());
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

    private String userKey(UUID userId) {
        return "USER#" + userId;
    }
}
