package com.escld.backend.feed;

import java.time.Instant;
import java.util.UUID;

public record FeedItem(UUID postId, UUID authorId, Instant createdAt) {
}
