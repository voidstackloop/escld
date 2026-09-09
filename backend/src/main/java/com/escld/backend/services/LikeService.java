package com.escld.backend.services;

import java.util.List;
import java.util.Set;
import java.util.UUID;

import com.escld.backend.dto.LikeResponse;

public interface LikeService {

    LikeResponse like(UUID postId, UUID userId);

    LikeResponse unlike(UUID postId, UUID userId);

    /** Which of these candidate post ids has this user liked — batched, see LikeStore. */
    Set<UUID> getLikedPostIds(UUID userId, List<UUID> postIds);

    /** This user's genuinely most-recently-liked posts, up to `limit` — see
     * LikeStore#listRecentLikedPostIds for why this isn't the same as a
     * plain limited scan of every like they've ever made. */
    List<UUID> getRecentLikedPostIds(UUID userId, int limit);
}
