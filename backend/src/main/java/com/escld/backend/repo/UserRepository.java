package com.escld.backend.repo;

import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.escld.backend.entities.User;

public interface UserRepository extends JpaRepository<User, UUID> {

    Optional<User> findByCognitoSub(UUID cognitoSub);

    Optional<User> findByUsername(String username);

    boolean existsByUsername(String username);

    // Atomic UPDATE ... SET count = count + 1, not a read-modify-write —
    // plain `user.setPostsCount(user.getPostsCount() + 1); save(user)` loses
    // updates when two requests read the same row before either commits
    // (verified: two posts/follows landing concurrently on the same user
    // only count once instead of twice). clearAutomatically=true: a bulk
    // UPDATE bypasses the persistence context, so a User already loaded
    // earlier in the same transaction would otherwise keep showing its
    // stale in-memory count afterward (see PostRepository's identical note
    // — caught live via the equivalent bug on post like counts).
    @Modifying(clearAutomatically = true)
    @Query("UPDATE User u SET u.postsCount = u.postsCount + 1 WHERE u.id = :userId")
    void incrementPostsCount(@Param("userId") UUID userId);

    @Modifying(clearAutomatically = true)
    @Query("UPDATE User u SET u.postsCount = CASE WHEN u.postsCount > 0 THEN u.postsCount - 1 ELSE 0 END WHERE u.id = :userId")
    void decrementPostsCount(@Param("userId") UUID userId);

    @Modifying(clearAutomatically = true)
    @Query("UPDATE User u SET u.followersCount = u.followersCount + 1 WHERE u.id = :userId")
    void incrementFollowersCount(@Param("userId") UUID userId);

    @Modifying(clearAutomatically = true)
    @Query("UPDATE User u SET u.followersCount = CASE WHEN u.followersCount > 0 THEN u.followersCount - 1 ELSE 0 END WHERE u.id = :userId")
    void decrementFollowersCount(@Param("userId") UUID userId);

    @Modifying(clearAutomatically = true)
    @Query("UPDATE User u SET u.followingCount = u.followingCount + 1 WHERE u.id = :userId")
    void incrementFollowingCount(@Param("userId") UUID userId);

    @Modifying(clearAutomatically = true)
    @Query("UPDATE User u SET u.followingCount = CASE WHEN u.followingCount > 0 THEN u.followingCount - 1 ELSE 0 END WHERE u.id = :userId")
    void decrementFollowingCount(@Param("userId") UUID userId);

    // Same clearAutomatically reasoning as the counters above — a direct
    // UPDATE, not load-modify-save, since the caller (StreamKeyServiceImpl)
    // never needs the rest of the User row, just to set this one column.
    @Modifying(clearAutomatically = true)
    @Query("UPDATE User u SET u.streamKey = :streamKey WHERE u.id = :userId")
    void updateStreamKey(@Param("userId") UUID userId, @Param("streamKey") UUID streamKey);
}
