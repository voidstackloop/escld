package com.escld.backend.repo;

import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.escld.backend.entities.PostLike;
import com.escld.backend.entities.PostLikeId;

public interface PostLikeRepository extends JpaRepository<PostLike, PostLikeId> {

    boolean existsByPostIdAndUserId(UUID postId, UUID userId);

    // Plain save()/delete() on PostLike is unreliable here: its @Id fields
    // are manually assigned (post_id/user_id are foreign keys, not
    // @GeneratedValue), so Hibernate can't tell "is this a new row" from the
    // id alone — its default fallback is an extra existence-check SELECT
    // before deciding INSERT vs. UPDATE, and that path was observed live to
    // sometimes merge into a no-op instead of inserting. A native, explicit
    // INSERT/DELETE removes that ambiguity entirely.
    @Modifying(clearAutomatically = true)
    @Query(value = "INSERT INTO post_likes (post_id, user_id) VALUES (:postId, :userId) ON CONFLICT DO NOTHING", nativeQuery = true)
    void insertLike(@Param("postId") UUID postId, @Param("userId") UUID userId);

    @Modifying(clearAutomatically = true)
    @Query(value = "DELETE FROM post_likes WHERE post_id = :postId AND user_id = :userId", nativeQuery = true)
    void deleteLike(@Param("postId") UUID postId, @Param("userId") UUID userId);

    // Batched "which of these candidate posts has this viewer liked" —
    // one query per feed/profile page instead of one per post (same
    // N+1-avoidance pattern as the author batching in FeedServiceImpl).
    @Query("SELECT pl.postId FROM PostLike pl WHERE pl.userId = :userId AND pl.postId IN :postIds")
    List<UUID> findLikedPostIds(@Param("userId") UUID userId, @Param("postIds") List<UUID> postIds);
}
