package com.escld.backend.services.impl;

import java.util.Map;
import java.util.UUID;

import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.cache.annotation.Caching;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.escld.backend.dto.UpdateUserProfileRequest;
import com.escld.backend.entities.User;
import com.escld.backend.exceptions.UserNotFoundException;
import com.escld.backend.exceptions.UsernameAlreadyTakenException;
import com.escld.backend.repo.UserRepository;
import com.escld.backend.search.UserSearchIndexer;
import com.escld.backend.services.UserService;
import com.escld.backend.user.CognitoUserAttributesClient;
import com.escld.backend.user.UserStatus;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

/**
 * getById/getOrProvisionByCognitoSub/getByUsername are Redis-cached (see
 * CacheConfig) — getOrProvisionByCognitoSub in particular resolves "who is
 * the current user" (creating their Postgres profile row on first sight of a
 * Cognito identity if needed) on nearly every authenticated request, making
 * it the highest-traffic read in the app. Writes made *through this class*
 * (updateProfile, activate/suspend/deactivate) evict all three cache entries
 * for the affected user.
 *
 * PostServiceImpl/FollowServiceImpl bump postsCount/followers/following
 * counts through the increment/decrement* methods below rather than a plain
 * read-modify-write `save(user)` — those counters are mutated by an atomic
 * `UPDATE ... SET count = count + 1` (see UserRepository) so two requests
 * touching the same user concurrently don't lose an update, which a
 * fetch-mutate-save pattern silently does under real concurrency. Each
 * increment/decrement only evicts the "usersById" cache (not by-username/by-
 * cognito-sub, since deriving those keys would need an extra read that
 * defeats the point of an atomic single-statement update) — the other two
 * caches self-expire within the TTL (30s), consistent with the existing
 * best-effort-consistency trade-off FollowServiceImpl's javadoc documents
 * for these same counters (Postgres vs. DynamoDB drift).
 */
@Service
@Slf4j
@RequiredArgsConstructor
public class UserServiceImpl implements UserService {

    private final UserRepository userRepository;
    private final UserSearchIndexer searchIndexer;
    private final CognitoUserAttributesClient cognitoUserAttributesClient;

    @Override
    @Cacheable(cacheNames = "usersById", key = "#id.toString()")
    public User getById(UUID id) {
        return userRepository.findById(id)
                .orElseThrow(() -> new UserNotFoundException(id));
    }

    /**
     * Cached the same way the old lookup-only getByCognitoSub was — this
     * resolves "who is the current caller" on nearly every authenticated
     * request, the highest-traffic read in the app, and that doesn't change
     * just because it can now also provision. @Cacheable only ever caches
     * this method's actual return value (a real, persisted User), never a
     * "not found yet" state, so caching the provisioning branch too is
     * exactly as safe as caching the plain-lookup branch was.
     */
    @Override
    @Transactional
    @Cacheable(cacheNames = "usersByCognitoSub", key = "T(java.util.UUID).fromString(#jwt.subject).toString()")
    public User getOrProvisionByCognitoSub(Jwt jwt) {
        UUID cognitoSub = UUID.fromString(jwt.getSubject());
        return userRepository.findByCognitoSub(cognitoSub)
                .orElseGet(() -> provision(cognitoSub, jwt));
    }

    /**
     * Builds the new profile from the caller's real Cognito attributes
     * (email/preferred_username/picture — the ones SignUp.tsx sets at
     * signup time) — see UserService#getOrProvisionByCognitoSub's own doc
     * for why this exists at all. Fetched via CognitoUserAttributesClient's
     * GetUser call, not read off the JWT itself: this app's resource server
     * only ever validates access tokens (see CognitoAccessTokenValidator),
     * and Cognito access tokens carry none of these custom/profile claims —
     * only ID tokens do, which this app never sends to the backend. A
     * username/email collision (someone else already took the requested
     * username — Cognito itself guarantees email uniqueness in this pool,
     * but not preferred_username) surfaces as the same
     * UsernameAlreadyTakenException the profile-update path already uses,
     * a 409 the frontend already knows how to render, rather than a raw 500
     * from the DB's own unique-index violation.
     */
    private User provision(UUID cognitoSub, Jwt jwt) {
        Map<String, String> attributes = cognitoUserAttributesClient.fetchAttributes(jwt.getTokenValue());
        String email = attributes.get("email");
        String preferredUsername = attributes.get("preferred_username");
        String picture = attributes.get("picture");

        User user = User.builder()
                .cognitoSub(cognitoSub)
                .username(preferredUsername)
                .email(email)
                .displayName(preferredUsername)
                .avatarUrl(picture)
                .build();

        try {
            User saved = userRepository.save(user);
            searchIndexer.index(saved);
            log.info("Provisioned new user profile for Cognito identity {}", cognitoSub);
            return saved;
        } catch (DataIntegrityViolationException e) {
            // Which unique constraint actually tripped changes the answer, so
            // don't assume it was the username one. A brand-new user's very
            // first page load fires several authenticated requests in
            // parallel (the feed and /users/me at minimum); each finds no row
            // yet and tries to provision, and the losers trip
            // users_cognito_sub_key. That is not a username collision — it is
            // the same person, provisioned microseconds earlier by whichever
            // request won — so re-read and return that row rather than
            // failing a legitimate sign-in. Observed for real against the
            // deployed stack, where the losing request's /api/v1/feed 500'd.
            // A genuine username collision finds nothing here and still
            // surfaces as the 409 the frontend already knows how to render.
            return userRepository.findByCognitoSub(cognitoSub)
                    .orElseThrow(() -> new UsernameAlreadyTakenException(preferredUsername));
        }
    }

    @Override
    @Cacheable(cacheNames = "usersByUsername", key = "#username.toLowerCase()")
    public User getByUsername(String username) {
        return userRepository.findByUsername(username)
                .orElseThrow(() -> new UserNotFoundException(username));
    }

    @Override
    public boolean usernameExists(String username) {
        return userRepository.existsByUsername(username);
    }

    @Override
    @Transactional
    @Caching(evict = {
            @CacheEvict(cacheNames = "usersById", key = "#result.id.toString()"),
            @CacheEvict(cacheNames = "usersByUsername", key = "#result.username.toLowerCase()"),
            @CacheEvict(cacheNames = "usersByCognitoSub", key = "#result.cognitoSub.toString()")
    })
    public User updateProfile(UUID userId, UpdateUserProfileRequest request) {
        User user = getById(userId);

        if (request.username() != null && !request.username().equals(user.getUsername())) {
            boolean sameIgnoringCase = request.username().equalsIgnoreCase(user.getUsername());
            if (!sameIgnoringCase && userRepository.existsByUsername(request.username())) {
                throw new UsernameAlreadyTakenException(request.username());
            }
            user.setUsername(request.username());
        }
        if (request.displayName() != null) {
            user.setDisplayName(request.displayName());
        }
        if (request.bio() != null) {
            user.setBio(request.bio());
        }
        if (request.avatarUrl() != null) {
            user.setAvatarUrl(request.avatarUrl());
        }
        if (request.coverImageUrl() != null) {
            user.setCoverImageUrl(request.coverImageUrl());
        }
        if (request.location() != null) {
            user.setLocation(request.location());
        }
        if (request.websiteUrl() != null) {
            user.setWebsiteUrl(request.websiteUrl());
        }
        if (request.birthdate() != null) {
            user.setBirthdate(request.birthdate());
        }
        if (request.privateAccount() != null) {
            user.setPrivateAccount(request.privateAccount());
        }

        User saved = userRepository.save(user);
        searchIndexer.index(saved);
        return saved;
    }

    @Override
    @Transactional
    @Caching(evict = {
            @CacheEvict(cacheNames = "usersById", key = "#result.id.toString()"),
            @CacheEvict(cacheNames = "usersByUsername", key = "#result.username.toLowerCase()"),
            @CacheEvict(cacheNames = "usersByCognitoSub", key = "#result.cognitoSub.toString()")
    })
    public User activateUser(UUID userId) {
        User user = setStatus(userId, UserStatus.ACTIVE);
        searchIndexer.index(user);
        return user;
    }

    @Override
    @Transactional
    @Caching(evict = {
            @CacheEvict(cacheNames = "usersById", key = "#result.id.toString()"),
            @CacheEvict(cacheNames = "usersByUsername", key = "#result.username.toLowerCase()"),
            @CacheEvict(cacheNames = "usersByCognitoSub", key = "#result.cognitoSub.toString()")
    })
    public User suspendUser(UUID userId) {
        User user = setStatus(userId, UserStatus.SUSPENDED);
        searchIndexer.delete(user);
        return user;
    }

    @Override
    @Transactional
    @Caching(evict = {
            @CacheEvict(cacheNames = "usersById", key = "#result.id.toString()"),
            @CacheEvict(cacheNames = "usersByUsername", key = "#result.username.toLowerCase()"),
            @CacheEvict(cacheNames = "usersByCognitoSub", key = "#result.cognitoSub.toString()")
    })
    public User deactivateUser(UUID userId) {
        User user = setStatus(userId, UserStatus.DEACTIVATED);
        searchIndexer.delete(user);
        return user;
    }

    private User setStatus(UUID userId, UserStatus status) {
        User user = getById(userId);
        user.setStatus(status);
        return userRepository.save(user);
    }

    @Override
    @Transactional
    @CacheEvict(cacheNames = "usersById", key = "#userId.toString()")
    public void incrementPostsCount(UUID userId) {
        userRepository.incrementPostsCount(userId);
    }

    @Override
    @Transactional
    @CacheEvict(cacheNames = "usersById", key = "#userId.toString()")
    public void decrementPostsCount(UUID userId) {
        userRepository.decrementPostsCount(userId);
    }

    @Override
    @Transactional
    @CacheEvict(cacheNames = "usersById", key = "#userId.toString()")
    public void incrementFollowersCount(UUID userId) {
        userRepository.incrementFollowersCount(userId);
    }

    @Override
    @Transactional
    @CacheEvict(cacheNames = "usersById", key = "#userId.toString()")
    public void decrementFollowersCount(UUID userId) {
        userRepository.decrementFollowersCount(userId);
    }

    @Override
    @Transactional
    @CacheEvict(cacheNames = "usersById", key = "#userId.toString()")
    public void incrementFollowingCount(UUID userId) {
        userRepository.incrementFollowingCount(userId);
    }

    @Override
    @Transactional
    @CacheEvict(cacheNames = "usersById", key = "#userId.toString()")
    public void decrementFollowingCount(UUID userId) {
        userRepository.decrementFollowingCount(userId);
    }
}
