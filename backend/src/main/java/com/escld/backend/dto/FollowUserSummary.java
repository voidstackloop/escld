package com.escld.backend.dto;

import java.util.UUID;

public record FollowUserSummary(
        UUID id,
        String username,
        String displayName,
        String avatarUrl,
        boolean verified) {
}
