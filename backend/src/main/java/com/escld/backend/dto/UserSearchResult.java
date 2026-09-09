package com.escld.backend.dto;

public record UserSearchResult(
        String id,
        String username,
        String displayName,
        String avatarUrl,
        boolean verified,
        int followersCount) {
}
