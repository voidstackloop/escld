package com.escld.backend.services;

import java.util.List;
import java.util.UUID;

import com.escld.backend.dto.FollowState;
import com.escld.backend.dto.FollowUserSummary;
import com.escld.backend.entities.User;

public interface FollowService {

    /** Follows immediately for public accounts, or files a pending request for private ones. */
    FollowState follow(UUID followerId, UUID followeeId);

    /** Unfollows if already following, or cancels a pending request either way. */
    void unfollow(UUID followerId, UUID followeeId);

    FollowState getFollowState(UUID followerId, UUID followeeId);

    void acceptFollowRequest(UUID currentUserId, UUID requesterId);

    void rejectFollowRequest(UUID currentUserId, UUID requesterId);

    List<FollowUserSummary> getPendingRequests(UUID userId);

    List<FollowUserSummary> getFollowers(UUID userId);

    List<FollowUserSummary> getFollowing(UUID userId);

    /** Self, non-private accounts, and accepted followers can see the followers/following lists. */
    boolean canViewFollowLists(UUID viewerId, User target);
}
