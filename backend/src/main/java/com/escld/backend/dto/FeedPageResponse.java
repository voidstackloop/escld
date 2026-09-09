package com.escld.backend.dto;

import java.util.List;
import java.util.Map;
import java.util.UUID;

public record FeedPageResponse(List<PostResponse> items, String nextCursor, UUID requestId,
        Map<UUID, RecommendationContext> recommendations) {
    public FeedPageResponse(List<PostResponse> items, String nextCursor) {
        this(items, nextCursor, null, Map.of());
    }
}
