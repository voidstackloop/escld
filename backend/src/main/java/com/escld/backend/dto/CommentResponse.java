package com.escld.backend.dto;

import java.time.Instant;
import java.util.UUID;

public record CommentResponse(
        UUID id,
        UUID postId,
        UUID authorId,
        String authorUsername,
        String authorDisplayName,
        String authorAvatarUrl,
        String text,
        Instant createdAt) {
}
