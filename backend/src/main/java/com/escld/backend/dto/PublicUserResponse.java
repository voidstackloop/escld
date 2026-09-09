package com.escld.backend.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * Public-facing profile view — deliberately excludes anything private
 * (email, moderation status, birthdate).
 */
public record PublicUserResponse(
        UUID id,
        String username,
        String displayName,
        String bio,
        String avatarUrl,
        String coverImageUrl,
        String location,
        String websiteUrl,
        boolean verified,
        boolean privateAccount,
        int followersCount,
        int followingCount,
        int postsCount,
        Instant createdAt) {
}
