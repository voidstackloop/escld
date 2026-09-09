package com.escld.backend.repo;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.escld.backend.entities.Post;

public interface PostRepository extends JpaRepository<Post, UUID> {

    // Keyset ("seek") pagination on the existing (user_id, created_at DESC)
    // index — O(log n) per page regardless of offset, unlike OFFSET/LIMIT
    // which gets slower the deeper you paginate. Ordered by (createdAt, id)
    // rather than createdAt alone: several posts can share the same
    // createdAt (verified against real seed data), and a cursor keyed on
    // createdAt alone silently drops whichever of those rows didn't make it
    // into the previous page — id as a tiebreaker makes the ordering (and
    // the cursor built from it) actually unique.
    @Query("SELECT p FROM Post p WHERE p.userId = :userId AND p.deletedAt IS NULL ORDER BY p.createdAt DESC, p.id DESC")
    List<Post> findFirstPageByUserId(@Param("userId") UUID userId, Pageable pageable);

    @Query("""
            SELECT p FROM Post p WHERE p.userId = :userId AND p.deletedAt IS NULL
            AND (p.createdAt < :cursorCreatedAt OR (p.createdAt = :cursorCreatedAt AND p.id < :cursorId))
            ORDER BY p.createdAt DESC, p.id DESC
            """)
    List<Post> findNextPageByUserId(
            @Param("userId") UUID userId,
            @Param("cursorCreatedAt") Instant cursorCreatedAt,
            @Param("cursorId") UUID cursorId,
            Pageable pageable);

    // Unpaginated, unlike the two methods above — used only by account
    // deletion (see AccountDeletionService), which needs every one of this
    // user's active posts in one sweep (to strip them from Elasticsearch, S3,
    // and every follower's fan-out feed), not a UI-facing page of them.
    @Query("SELECT p FROM Post p WHERE p.userId = :userId AND p.deletedAt IS NULL")
    List<Post> findAllActiveByUserId(@Param("userId") UUID userId);

    // Same non-atomic-update problem as UserRepository's counters — see its
    // javadoc. clearAutomatically=true matters here specifically: a bulk
    // UPDATE like this bypasses the persistence context entirely, so a
    // Post already loaded earlier in the same transaction (e.g. the
    // existence check in LikeServiceImpl.like()) keeps showing its stale
    // in-memory count afterward unless the context is cleared — verified
    // live (a like recorded correctly but the returned count stayed at 0
    // until this was added).
    @Modifying(clearAutomatically = true)
    @Query("UPDATE Post p SET p.commentCount = p.commentCount + 1 WHERE p.id = :postId")
    void incrementCommentCount(@Param("postId") UUID postId);

    @Modifying(clearAutomatically = true)
    @Query("UPDATE Post p SET p.commentCount = CASE WHEN p.commentCount > 0 THEN p.commentCount - 1 ELSE 0 END WHERE p.id = :postId")
    void decrementCommentCount(@Param("postId") UUID postId);

    @Modifying(clearAutomatically = true)
    @Query("UPDATE Post p SET p.likeCount = p.likeCount + 1 WHERE p.id = :postId")
    void incrementLikeCount(@Param("postId") UUID postId);

    @Modifying(clearAutomatically = true)
    @Query("UPDATE Post p SET p.likeCount = CASE WHEN p.likeCount > 0 THEN p.likeCount - 1 ELSE 0 END WHERE p.id = :postId")
    void decrementLikeCount(@Param("postId") UUID postId);

    // Backed by the partial unique index posts_one_live_per_user_idx (see
    // V6 migration) — at most one row can ever match this per user, so
    // Optional (not List) is the correct return shape, not just convenient.
    @Query("SELECT p FROM Post p WHERE p.userId = :userId AND p.liveStatus = com.escld.backend.post.LiveStatus.LIVE AND p.deletedAt IS NULL")
    Optional<Post> findLiveByUserId(@Param("userId") UUID userId);

    // peakViewerCount is persisted in the same statement, not a separate
    // save() — see Post.peakViewerCount's own doc for why it has to survive
    // past LiveViewerPresenceService's Redis key being cleared right after
    // this call (LiveStreamServiceImpl.end).
    @Modifying(clearAutomatically = true)
    @Query("UPDATE Post p SET p.liveStatus = com.escld.backend.post.LiveStatus.ENDED, p.liveEndedAt = :endedAt, "
            + "p.peakViewerCount = :peakViewerCount WHERE p.id = :postId")
    void endLiveStream(
            @Param("postId") UUID postId, @Param("endedAt") Instant endedAt, @Param("peakViewerCount") int peakViewerCount);
}
