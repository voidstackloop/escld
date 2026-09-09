package com.escld.backend.dto;

import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

import com.escld.backend.user.UserStatus;

/**
 * Full profile view — only ever returned to the account owner.
 */
public record UserResponse(
        UUID id,
        String username,
        String email,
        String displayName,
        String bio,
        String avatarUrl,
        String coverImageUrl,
        String location,
        String websiteUrl,
        LocalDate birthdate,
        boolean verified,
        boolean privateAccount,
        UserStatus status,
        int followersCount,
        int followingCount,
        int postsCount,
        Instant createdAt,
        Instant updatedAt) {
}
