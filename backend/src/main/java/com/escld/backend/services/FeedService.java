package com.escld.backend.services;

import java.util.UUID;

import com.escld.backend.dto.FeedPageResponse;

public interface FeedService {

    FeedPageResponse getFeed(UUID userId, int limit, String cursor);

    /** Explicit mode path: null/blank = legacy behavior; "following" =
     * eligible followed+self chrono snapshots; "for_you" = ranked snapshots. */
    default FeedPageResponse getFeed(UUID userId, int limit, String cursor, String mode) {
        return getFeed(userId, limit, cursor);
    }
}
