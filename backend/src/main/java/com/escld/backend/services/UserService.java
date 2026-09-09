package com.escld.backend.services;

import java.util.UUID;

import org.springframework.security.oauth2.jwt.Jwt;

import com.escld.backend.dto.UpdateUserProfileRequest;
import com.escld.backend.entities.User;

public interface UserService {

    User getById(UUID id);

    /**
     * The one call every authenticated endpoint should use to resolve "who
     * is the current caller" — creates the Postgres profile row on first
     * sight of a Cognito identity (from the JWT's email/preferred_username/
     * picture claims) rather than 404ing, since nothing else in this app (no
     * post-confirmation Lambda, no explicit "create profile" call from the
     * frontend) ever provisions that row.
     */
    User getOrProvisionByCognitoSub(Jwt jwt);

    User getByUsername(String username);

    boolean usernameExists(String username);

    User updateProfile(UUID userId, UpdateUserProfileRequest request);

    User activateUser(UUID userId);

    User suspendUser(UUID userId);

    User deactivateUser(UUID userId);

    void incrementPostsCount(UUID userId);

    void decrementPostsCount(UUID userId);

    void incrementFollowersCount(UUID userId);

    void decrementFollowersCount(UUID userId);

    void incrementFollowingCount(UUID userId);

    void decrementFollowingCount(UUID userId);
}
