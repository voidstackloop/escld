package com.escld.backend.services.impl;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.escld.backend.cache.RedisBatchCache;
import com.escld.backend.config.CacheConfig;
import com.escld.backend.dto.FollowState;
import com.escld.backend.dto.FollowUserSummary;
import com.escld.backend.entities.User;
import com.escld.backend.exceptions.FollowRequestNotFoundException;
import com.escld.backend.exceptions.SelfFollowException;
import com.escld.backend.exceptions.UserNotFoundException;
import com.escld.backend.feed.FeedStore;
import com.escld.backend.follow.FollowGraphStore;
import com.escld.backend.metrics.EmfMetrics;
import com.escld.backend.repo.PostRepository;
import com.escld.backend.repo.UserRepository;
import com.escld.backend.services.FollowService;
import com.escld.backend.services.UserService;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

/**
 * DynamoDB (via FollowGraphStore) is the source of truth for "who follows whom"
 * and pending requests. Postgres followersCount/followingCount are a best-effort
 * denormalization for fast profile reads — the two stores aren't updated in one
 * atomic transaction, so brief drift between them is possible. Acceptable
 * trade-off for a social graph; counts could be periodically reconciled from
 * DynamoDB if drift ever matters.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class FollowServiceImpl implements FollowService {

    /** How many of the followee's most recent posts to backfill into a new follower's feed. */
    private static final int BACKFILL_SIZE = 20;

    private final FollowGraphStore graphStore;
    private final UserRepository userRepository;
    private final UserService userService;
    private final PostRepository postRepository;
    private final FeedStore feedStore;
    private final EmfMetrics emfMetrics;
    private final RedisBatchCache redisBatchCache;

    @Override
    @Transactional
    public FollowState follow(UUID followerId, UUID followeeId) {
        if (followerId.equals(followeeId)) {
            throw new SelfFollowException();
        }

        if (graphStore.isFollowing(followerId, followeeId)) {
            return FollowState.FOLLOWING;
        }

        User followee = getUser(followeeId);

        if (followee.isPrivateAccount()) {
            if (!graphStore.hasPendingRequest(followerId, followeeId)) {
                graphStore.createRequest(followerId, followeeId);
            }
            return FollowState.PENDING;
        }

        User follower = getUser(followerId);
        establishFollow(follower, followee);
        return FollowState.FOLLOWING;
    }

    @Override
    @Transactional
    public void unfollow(UUID followerId, UUID followeeId) {
        if (graphStore.hasPendingRequest(followerId, followeeId)) {
            graphStore.deleteRequest(followerId, followeeId);
            return;
        }

        if (!graphStore.isFollowing(followerId, followeeId)) {
            return;
        }

        if (graphStore.unfollow(followerId, followeeId)) {
            userService.decrementFollowingCount(followerId);
            userService.decrementFollowersCount(followeeId);
        }
    }

    @Override
    public FollowState getFollowState(UUID followerId, UUID followeeId) {
        if (graphStore.isFollowing(followerId, followeeId)) {
            return FollowState.FOLLOWING;
        }
        if (graphStore.hasPendingRequest(followerId, followeeId)) {
            return FollowState.PENDING;
        }
        return FollowState.NOT_FOLLOWING;
    }

    @Override
    @Transactional
    public void acceptFollowRequest(UUID currentUserId, UUID requesterId) {
        if (!graphStore.hasPendingRequest(requesterId, currentUserId)) {
            throw new FollowRequestNotFoundException();
        }

        graphStore.deleteRequest(requesterId, currentUserId);

        // The requester may already be following (e.g. the account went
        // private->public between the request being made and now — see
        // establishFollow's own stale-request cleanup) — without this
        // guard, accepting a stale request re-runs establishFollow and
        // double-counts followers/following for an edge that already
        // exists.
        if (graphStore.isFollowing(requesterId, currentUserId)) {
            return;
        }

        User follower = getUser(requesterId);
        User followee = getUser(currentUserId);
        establishFollow(follower, followee);
        emfMetrics.increment("follow_requests_total", Map.of("result", "ACCEPTED"));
    }

    @Override
    @Transactional
    public void rejectFollowRequest(UUID currentUserId, UUID requesterId) {
        if (!graphStore.hasPendingRequest(requesterId, currentUserId)) {
            throw new FollowRequestNotFoundException();
        }
        graphStore.deleteRequest(requesterId, currentUserId);
        emfMetrics.increment("follow_requests_total", Map.of("result", "REJECTED"));
    }

    @Override
    public List<FollowUserSummary> getPendingRequests(UUID userId) {
        return resolve(graphStore.listPendingRequests(userId));
    }

    @Override
    public List<FollowUserSummary> getFollowers(UUID userId) {
        return resolve(graphStore.listFollowers(userId));
    }

    @Override
    public List<FollowUserSummary> getFollowing(UUID userId) {
        return resolve(graphStore.listFollowing(userId));
    }

    @Override
    public boolean canViewFollowLists(UUID viewerId, User target) {
        if (viewerId.equals(target.getId())) {
            return true;
        }
        if (!target.isPrivateAccount()) {
            return true;
        }
        return graphStore.isFollowing(viewerId, target.getId());
    }

    private void establishFollow(User follower, User followee) {
        if (!graphStore.follow(follower.getId(), followee.getId())) {
            return;
        }

        // Covers the public-account path, where a follow can be established
        // without ever going through the private-account request flow that
        // normally clears this: if a REQUEST# item exists from before the
        // account went public (or any other stale state), leave it behind
        // and it'll surface as a ghost pending-request that, if "accepted"
        // later, re-runs this method and double-counts followers/following
        // for an edge that's already established.
        graphStore.deleteRequest(follower.getId(), followee.getId());

        userService.incrementFollowingCount(follower.getId());
        userService.incrementFollowersCount(followee.getId());

        try {
            var recentPosts = postRepository.findFirstPageByUserId(followee.getId(), PageRequest.of(0, BACKFILL_SIZE));
            feedStore.backfillRecentPosts(follower.getId(), recentPosts);
        } catch (Exception e) {
            // Best-effort, same reasoning as the SQS publishers: the follow
            // relationship itself already succeeded. Worst case the new
            // follower's feed just looks empty until the followee posts
            // again, rather than the follow action failing outright.
            log.error("Failed to backfill recent posts for follower {} of {}", follower.getId(), followee.getId(), e);
        }
    }

    private User getUser(UUID userId) {
        return userRepository.findById(userId).orElseThrow(() -> new UserNotFoundException(userId));
    }

    private List<FollowUserSummary> resolve(List<UUID> ids) {
        if (ids.isEmpty()) {
            return List.of();
        }
        // Routed through the same "usersById" cache FeedServiceImpl/
        // CommentController already share with UserServiceImpl#getById,
        // rather than hitting Postgres cold on every followers/following/
        // pending-requests list view. Rebuilt in `ids`' own (DynamoDB-
        // determined, typically recency) order explicitly, since a Map
        // return and a plain findAllById IN-clause both make no ordering
        // guarantee of their own.
        Map<UUID, User> usersById = redisBatchCache.getAll(
                "usersById",
                ids,
                UUID::toString,
                CacheConfig.USER_CACHE_TTL,
                missingIds -> {
                    Map<UUID, User> loaded = new java.util.HashMap<>();
                    userRepository.findAllById(missingIds).forEach(u -> loaded.put(u.getId(), u));
                    return loaded;
                });
        return ids.stream()
                .map(usersById::get)
                .filter(java.util.Objects::nonNull)
                .map(u -> new FollowUserSummary(u.getId(), u.getUsername(), u.getDisplayName(), u.getAvatarUrl(),
                        u.isVerified()))
                .toList();
    }
}
