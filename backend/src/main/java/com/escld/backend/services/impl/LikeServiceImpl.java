package com.escld.backend.services.impl;

import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.escld.backend.analytics.AnalyticsEventPublisher;
import com.escld.backend.counters.CounterProjectionService;
import com.escld.backend.dto.LikeResponse;
import com.escld.backend.like.LikeStore;
import com.escld.backend.services.LikeService;
import com.escld.backend.services.PostService;

import lombok.RequiredArgsConstructor;

@Service
@RequiredArgsConstructor
public class LikeServiceImpl implements LikeService {

    private final LikeStore likeStore;
    private final PostService postService;
    private final AnalyticsEventPublisher analyticsEventPublisher;
    private final CounterProjectionService counterProjections;

    @Override
    @Transactional
    public LikeResponse like(UUID postId, UUID userId) {
        // Ensures the post exists (and isn't soft-deleted) before liking it.
        postService.getById(postId);

        UUID eventId = UUID.randomUUID();
        if (likeStore.like(postId, userId, eventId)) {
            // Through PostService, not PostRepository directly — this evicts
            // postsById (see PostServiceImpl), so the getById call right
            // below reads the fresh count instead of a cached pre-increment
            // value from the very like that just happened.
            // Receipt makes the counter delta idempotent on redelivered
            // outbox events: same eventId replays are no-ops.
            if (counterProjections.tryClaim(eventId, CounterProjectionService.PROJECTION_VERSION,
                    "post:" + postId + ":likeCount")) {
                postService.incrementLikeCount(postId);
            }
            analyticsEventPublisher.publishPostLiked(postId);
        }

        // liked is always true here regardless of whether this call just
        // created the edge or it already existed (idempotent) — no need to
        // re-derive it from another query.
        return new LikeResponse(true, postService.getById(postId).getLikeCount());
    }

    @Override
    @Transactional
    public LikeResponse unlike(UUID postId, UUID userId) {
        UUID eventId = UUID.randomUUID();
        if (likeStore.unlike(postId, userId, eventId)) {
            if (counterProjections.tryClaim(eventId, CounterProjectionService.PROJECTION_VERSION,
                    "post:" + postId + ":likeCount")) {
                postService.decrementLikeCount(postId);
            }
        }

        return new LikeResponse(false, postService.getById(postId).getLikeCount());
    }

    @Override
    public Set<UUID> getLikedPostIds(UUID userId, List<UUID> postIds) {
        if (postIds.isEmpty()) {
            return Set.of();
        }
        return likeStore.getLikedPostIds(userId, postIds);
    }

    @Override
    public List<UUID> getRecentLikedPostIds(UUID userId, int limit) {
        return likeStore.listRecentLikedPostIds(userId, limit);
    }
}
