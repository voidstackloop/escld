package com.escld.backend.feed;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import com.escld.backend.entities.Post;

import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.BatchWriteItemRequest;
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest;
import software.amazon.awssdk.services.dynamodb.model.PutRequest;
import software.amazon.awssdk.services.dynamodb.model.QueryRequest;
import software.amazon.awssdk.services.dynamodb.model.QueryResponse;
import software.amazon.awssdk.services.dynamodb.model.WriteRequest;

/**
 * Fan-out-on-write feed. Most items are written here by the feed worker (see
 * feed-worker/) when a followed user posts — one item per follower's
 * partition, same "write under every reader's own partition" trade as
 * FollowGraphStore. The backend itself only writes directly for the
 * follow-time backfill (see backfillRecentPosts) — a small, synchronous,
 * user-triggered write that doesn't need the async embedding/indexing
 * pipeline the worker exists for.
 *
 * pk = USER#<feed owner>, sk = POST#<createdAt ISO-8601>#<postId> — ISO-8601
 * timestamps sort lexicographically in creation order, so a descending query
 * (ScanIndexForward=false) is the whole "give me the newest N posts" query.
 */
@Component
public class FeedStore {

    private static final String POST_PREFIX = "POST#";

    private final DynamoDbClient dynamoDbClient;
    private final String tableName;

    public FeedStore(DynamoDbClient dynamoDbClient, @Value("${app.dynamodb.feed-table-name}") String tableName) {
        this.dynamoDbClient = dynamoDbClient;
        this.tableName = tableName;
    }

    public FeedPage queryFeed(UUID ownerId, int limit, String cursor) {
        QueryRequest.Builder request = QueryRequest.builder()
                .tableName(tableName)
                .keyConditionExpression("pk = :pk AND begins_with(sk, :skPrefix)")
                .expressionAttributeValues(Map.of(
                        ":pk", AttributeValue.fromS(userKey(ownerId)),
                        ":skPrefix", AttributeValue.fromS(POST_PREFIX)))
                .scanIndexForward(false)
                .limit(limit);

        if (cursor != null && !cursor.isBlank()) {
            request.exclusiveStartKey(Map.of(
                    "pk", AttributeValue.fromS(userKey(ownerId)),
                    "sk", AttributeValue.fromS(decodeCursor(cursor))));
        }

        QueryResponse response = dynamoDbClient.query(request.build());

        List<FeedItem> items = new ArrayList<>();
        for (Map<String, AttributeValue> item : response.items()) {
            items.add(new FeedItem(
                    UUID.fromString(item.get("postId").s()),
                    UUID.fromString(item.get("authorId").s()),
                    Instant.parse(item.get("createdAt").s())));
        }

        String nextCursor = null;
        if (response.hasLastEvaluatedKey() && !response.lastEvaluatedKey().isEmpty()) {
            nextCursor = encodeCursor(response.lastEvaluatedKey().get("sk").s());
        }

        return new FeedPage(items, nextCursor);
    }

    /**
     * Copies a newly-followed user's recent posts straight into the new
     * follower's feed partition. Without this, following someone is
     * invisible in your feed until they post again — fan-out-on-write only
     * ever pushes forward from the moment a post is created, it never
     * backfills history, so a brand-new follow needs an explicit nudge.
     */
    public void backfillRecentPosts(UUID followerId, List<Post> recentPosts) {
        if (recentPosts.isEmpty()) {
            return;
        }

        List<WriteRequest> writes = recentPosts.stream().map(post -> {
            String createdAt = post.getCreatedAt().toString();
            return WriteRequest.builder()
                    .putRequest(PutRequest.builder()
                            .item(Map.of(
                                    "pk", AttributeValue.fromS(userKey(followerId)),
                                    "sk", AttributeValue.fromS(POST_PREFIX + createdAt + "#" + post.getId()),
                                    "postId", AttributeValue.fromS(post.getId().toString()),
                                    "authorId", AttributeValue.fromS(post.getUserId().toString()),
                                    "createdAt", AttributeValue.fromS(createdAt)))
                            .build())
                    .build();
        }).toList();

        // BatchWriteItem caps at 25 items per call - chunked defensively even
        // though FollowServiceImpl.BACKFILL_SIZE is currently 20, so this
        // still holds if that constant ever grows. Was a sequential PutItem
        // per post (up to 20 synchronous round trips, tens to ~100ms of
        // added latency on every follow of an account with post history);
        // this is 1 call in the common case, never more than ceil(N/25).
        for (int start = 0; start < writes.size(); start += 25) {
            List<WriteRequest> chunk = writes.subList(start, Math.min(start + 25, writes.size()));
            dynamoDbClient.batchWriteItem(BatchWriteItemRequest.builder()
                    .requestItems(Map.of(tableName, chunk))
                    .build());
        }
    }

    /** Removes one post from one recipient's feed partition — used during
     * account deletion to strip a deleted author's posts out of every
     * follower's feed (fan-out-on-write means those items live under each
     * follower's own partition, not the author's — see the class doc). The
     * caller must have already captured the follower list and each post's
     * createdAt (from Postgres) before deleting the follow graph/posts. */
    public void removePost(UUID recipientId, Instant createdAt, UUID postId) {
        dynamoDbClient.deleteItem(DeleteItemRequest.builder()
                .tableName(tableName)
                .key(Map.of(
                        "pk", AttributeValue.fromS(userKey(recipientId)),
                        "sk", AttributeValue.fromS(POST_PREFIX + createdAt + "#" + postId)))
                .build());
    }

    /** Deletes this user's own feed partition entirely — the posts they were
     * shown, not the posts they authored (see removePost for that side).
     * Used during account deletion. */
    public void deleteAllForOwner(UUID ownerId) {
        String pk = userKey(ownerId);
        String exclusiveStartSk = null;

        while (true) {
            QueryRequest.Builder request = QueryRequest.builder()
                    .tableName(tableName)
                    .keyConditionExpression("pk = :pk AND begins_with(sk, :skPrefix)")
                    .expressionAttributeValues(Map.of(
                            ":pk", AttributeValue.fromS(pk),
                            ":skPrefix", AttributeValue.fromS(POST_PREFIX)))
                    .projectionExpression("sk");
            if (exclusiveStartSk != null) {
                request.exclusiveStartKey(Map.of(
                        "pk", AttributeValue.fromS(pk),
                        "sk", AttributeValue.fromS(exclusiveStartSk)));
            }

            QueryResponse response = dynamoDbClient.query(request.build());
            for (Map<String, AttributeValue> item : response.items()) {
                dynamoDbClient.deleteItem(DeleteItemRequest.builder()
                        .tableName(tableName)
                        .key(Map.of("pk", AttributeValue.fromS(pk), "sk", item.get("sk")))
                        .build());
            }

            if (!response.hasLastEvaluatedKey() || response.lastEvaluatedKey().isEmpty()) {
                break;
            }
            exclusiveStartSk = response.lastEvaluatedKey().get("sk").s();
        }
    }

    private String encodeCursor(String sk) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(sk.getBytes(StandardCharsets.UTF_8));
    }

    private String decodeCursor(String cursor) {
        return new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
    }

    private String userKey(UUID userId) {
        return "USER#" + userId;
    }
}
