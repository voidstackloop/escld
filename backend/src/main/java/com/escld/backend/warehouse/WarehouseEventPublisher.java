package com.escld.backend.warehouse;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.slf4j.MDC;
import org.springframework.stereotype.Component;

import lombok.extern.slf4j.Slf4j;

import com.escld.backend.config.CorrelationIdFilter;
import com.escld.backend.metrics.EmfMetrics;

/**
 * Writes versioned domain events to the relational outbox. When this method
 * is called inside a relational transaction, the state change and event are
 * committed or rolled back together. WarehouseOutboxRelay performs the
 * Kafka network operation after commit and retries with the stable event id.
 *
 * DynamoDB-backed likes, follows, and hides use DynamoWarehouseOutbox instead, so
 * their edge records and events share one DynamoDB transaction.
 */
@Component
@Slf4j
public class WarehouseEventPublisher {

    public static final String TOPIC_POST_CREATED = "post.created";
    public static final String TOPIC_POST_LIKED = "post.liked";
    public static final String TOPIC_POST_UNLIKED = "post.unliked";
    public static final String TOPIC_POST_COMMENTED = "post.commented";
    public static final String TOPIC_POST_COMMENT_DELETED = "post.comment_deleted";
    public static final String TOPIC_POST_HIDDEN = "post.hidden";
    public static final String TOPIC_POST_UNHIDDEN = "post.unhidden";
    public static final String TOPIC_USER_FOLLOWED = "user.followed";
    public static final String TOPIC_USER_UNFOLLOWED = "user.unfollowed";
    public static final String TOPIC_LIVE_STARTED = "live.started";
    public static final String TOPIC_LIVE_ENDED = "live.ended";
    public static final String TOPIC_POST_IMPRESSION = "post.impression";
    public static final String TOPIC_POST_DWELL = "post.dwell";
    public static final String TOPIC_FEED_SERVED = "feed.served";
    public static final String TOPIC_MEDIA_PROGRESS = "media.progress";
    public static final String TOPIC_USER_DELETION_REQUESTED = "user.deletion_requested";
    public static final String TOPIC_USER_DELETION_COMPLETED = "user.deletion_completed";

    private static final String ENVELOPE_VERSION = "2";
    private static final String PRODUCER = "backend";

    private final WarehouseOutboxStore outboxStore;
    private final EmfMetrics emfMetrics;

    public WarehouseEventPublisher(WarehouseOutboxStore outboxStore, EmfMetrics emfMetrics) {
        this.outboxStore = outboxStore;
        this.emfMetrics = emfMetrics;
    }

    public void publishPostCreated(UUID postId, UUID authorId) {
        enqueue(TOPIC_POST_CREATED, postId.toString(), authorId, "post", postId.toString(), 1L, Map.of(
                "postId", postId.toString(),
                "authorId", authorId.toString()));
    }

    public void publishPostLiked(UUID postId, UUID userId) {
        enqueue(TOPIC_POST_LIKED, postId.toString(), userId, "post_like", postId + ":" + userId, null, Map.of(
                "postId", postId.toString(),
                "userId", userId.toString()));
    }

    public void publishPostCommented(UUID postId, UUID commentId, UUID authorId) {
        enqueue(TOPIC_POST_COMMENTED, postId.toString(), authorId, "comment", commentId.toString(), 1L, Map.of(
                "postId", postId.toString(),
                "commentId", commentId.toString(),
                "authorId", authorId.toString()));
    }

    public void publishPostCommentDeleted(UUID postId, UUID commentId, UUID commentAuthorId,
            UUID deletedById, String deletionReason) {
        enqueue(TOPIC_POST_COMMENT_DELETED, postId.toString(), deletedById,
                "comment", commentId.toString(), null, Map.of(
                        "postId", postId.toString(),
                        "commentId", commentId.toString(),
                        "commentAuthorId", commentAuthorId.toString(),
                        "deletedById", deletedById.toString(),
                        "deletionReason", deletionReason));
    }

    public void publishUserFollowed(UUID followerId, UUID followeeId) {
        enqueue(TOPIC_USER_FOLLOWED, followeeId.toString(), followerId, "follow", followerId + ":" + followeeId, null, Map.of(
                "followerId", followerId.toString(),
                "followeeId", followeeId.toString()));
    }

    public void publishUserUnfollowed(UUID followerId, UUID followeeId) {
        enqueue(TOPIC_USER_UNFOLLOWED, followeeId.toString(), followerId, "follow", followerId + ":" + followeeId, null, Map.of(
                "followerId", followerId.toString(),
                "followeeId", followeeId.toString()));
    }

    public void publishLiveStarted(UUID postId, UUID authorId, String title) {
        enqueue(TOPIC_LIVE_STARTED, postId.toString(), authorId, "post", postId.toString(), null, Map.of(
                "postId", postId.toString(),
                "authorId", authorId.toString(),
                "title", title));
    }

    /** `durationSeconds` is computed by the caller (LiveStreamServiceImpl)
     * from the Post's own liveStartedAt/liveEndedAt — kept out of this
     * class so the one place that owns "how long was this stream" is the
     * same place that owns ending it, not duplicated here. `peakViewerCount`
     * comes from LiveViewerPresenceService's Redis-backed tracking — the one
     * piece of this event that's only ever an estimate (heartbeat-derived,
     * not an exact count), not a guarantee. */
    public void publishLiveEnded(UUID postId, UUID authorId, long durationSeconds, int peakViewerCount) {
        enqueue(TOPIC_LIVE_ENDED, postId.toString(), authorId, "post", postId.toString(), null, Map.of(
                "postId", postId.toString(),
                "authorId", authorId.toString(),
                "durationSeconds", durationSeconds,
                "peakViewerCount", peakViewerCount));
    }

    public void publishUserDeletionRequested(UUID userId) {
        enqueue(TOPIC_USER_DELETION_REQUESTED, userId.toString(), userId, "user", userId.toString(), null,
                Map.of("userId", userId.toString()));
    }

    public void publishUserDeletionCompleted(UUID userId, List<String> ownedPostIds) {
        enqueue(TOPIC_USER_DELETION_COMPLETED, userId.toString(), userId, "user", userId.toString(), null,
                Map.of("userId", userId.toString(), "ownedPostIds", ownedPostIds));
    }

    public void publishObservation(UUID eventId, String eventType, Instant occurredAt, UUID actorId,
            UUID postId, UUID requestId, int position, UUID sessionId, Map<String, Object> clientPayload) {
        var payload = new java.util.HashMap<String, Object>(clientPayload);
        payload.put("postId", postId.toString());
        payload.put("requestId", requestId.toString());
        payload.put("position", position);
        if (sessionId != null) payload.put("sessionId", sessionId.toString());
        enqueue(eventId, eventType, postId.toString(), occurredAt, actorId, "feed_observation",
                requestId + ":" + postId + ":" + position, null, sessionId, requestId, null, null, payload);
    }

    /**
     * Records the exact ordered recommendations returned for one feed request.
     * This is deliberately best-effort: the durable outbox is used whenever it
     * is available, but an analytics database failure must not make the read
     * path unavailable. Failures remain visible through a dedicated metric and
     * structured log entry.
     */
    public boolean publishFeedServed(UUID viewerId, UUID requestId, List<ServedRecommendation> orderedItems,
            boolean continuation, boolean servedFromSnapshot, boolean hasMore,
            String experimentId, String experimentVariant) {
        try {
            enqueue(TOPIC_FEED_SERVED, viewerId.toString(), viewerId, "feed_request", requestId.toString(), null,
                    null, requestId, experimentId, experimentVariant,
                    Map.of(
                            "requestId", requestId.toString(),
                            "itemCount", orderedItems.size(),
                            "continuation", continuation,
                            "servedFromSnapshot", servedFromSnapshot,
                            "hasMore", hasMore,
                            "orderedItems", orderedItems));
            return true;
        } catch (RuntimeException failure) {
            emfMetrics.increment("warehouse_outbox_enqueue_failed_total", Map.of("eventType", TOPIC_FEED_SERVED));
            log.warn("Failed to persist feed.served lineage for requestId={}", requestId, failure);
            return false;
        }
    }

    public record ServedRecommendation(UUID postId, int position, String source, String reasonCode) {}

    private void enqueue(
            String eventType,
            String partitionKey,
            UUID actorId,
            String entityType,
            String entityId,
            Long entityVersion,
            Map<String, Object> payload) {
        enqueue(UUID.randomUUID(), eventType, partitionKey, Instant.now(), actorId, entityType, entityId,
                entityVersion, null, null, null, null, payload);
    }

    private void enqueue(
            String eventType,
            String partitionKey,
            UUID actorId,
            String entityType,
            String entityId,
            Long entityVersion,
            UUID sessionId,
            UUID requestId,
            String experimentId,
            String experimentVariant,
            Map<String, Object> payload) {
        enqueue(UUID.randomUUID(), eventType, partitionKey, Instant.now(), actorId, entityType, entityId,
                entityVersion, sessionId, requestId, experimentId, experimentVariant, payload);
    }

    private void enqueue(UUID eventId, String eventType, String partitionKey, Instant occurredAt,
            UUID actorId, String entityType, String entityId, Long entityVersion, Map<String, Object> payload) {
        enqueue(eventId, eventType, partitionKey, occurredAt, actorId, entityType, entityId, entityVersion,
                null, null, null, null, payload);
    }

    private void enqueue(UUID eventId, String eventType, String partitionKey, Instant occurredAt,
            UUID actorId, String entityType, String entityId, Long entityVersion,
            UUID sessionId, UUID requestId, String experimentId, String experimentVariant,
            Map<String, Object> payload) {
        WarehouseEvent event = new WarehouseEvent(
                eventId,
                eventType,
                ENVELOPE_VERSION,
                partitionKey,
                occurredAt,
                PRODUCER,
                actorId,
                entityType,
                entityId,
                entityVersion,
                MDC.get(CorrelationIdFilter.MDC_KEY),
                sessionId,
                requestId,
                experimentId,
                experimentVariant,
                payload);
        outboxStore.enqueue(event);
        emfMetrics.increment("warehouse_outbox_enqueued_total", Map.of("eventType", eventType));
    }
}
