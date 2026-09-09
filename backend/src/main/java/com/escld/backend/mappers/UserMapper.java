package com.escld.backend.mappers;

import org.springframework.stereotype.Component;

import com.escld.backend.dto.PublicUserResponse;
import com.escld.backend.dto.UserResponse;
import com.escld.backend.entities.User;

@Component
public class UserMapper {

    public UserResponse toUserResponse(User user) {
        return new UserResponse(
                user.getId(),
                user.getUsername(),
                user.getEmail(),
                user.getDisplayName(),
                user.getBio(),
                user.getAvatarUrl(),
                user.getCoverImageUrl(),
                user.getLocation(),
                user.getWebsiteUrl(),
                user.getBirthdate(),
                user.isVerified(),
                user.isPrivateAccount(),
                user.getStatus(),
                user.getFollowersCount(),
                user.getFollowingCount(),
                user.getPostsCount(),
                user.getCreatedAt(),
                user.getUpdatedAt());
    }

    public PublicUserResponse toPublicUserResponse(User user) {
        return new PublicUserResponse(
                user.getId(),
                user.getUsername(),
                user.getDisplayName(),
                user.getBio(),
                user.getAvatarUrl(),
                user.getCoverImageUrl(),
                user.getLocation(),
                user.getWebsiteUrl(),
                user.isVerified(),
                user.isPrivateAccount(),
                user.getFollowersCount(),
                user.getFollowingCount(),
                user.getPostsCount(),
                user.getCreatedAt());
    }
}
