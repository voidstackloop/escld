package com.escld.backend.repo;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.escld.backend.entities.Comment;

public interface CommentRepository extends JpaRepository<Comment, UUID> {

    @Query("SELECT c FROM Comment c WHERE c.postId = :postId AND c.deletedAt IS NULL ORDER BY c.createdAt DESC")
    List<Comment> findByPostIdOrderByCreatedAtDesc(@Param("postId") UUID postId);

    List<Comment> findAllByUserIdAndDeletedAtIsNull(UUID userId);

    // Feed ranking's engagement-history sample (see FeedServiceImpl) — real
    // ORDER BY, unlike LikeStore's DynamoDB equivalent (see
    // LikeStore#listRecentLikedPostIds's javadoc for why that one needed a
    // new GSI instead of a plain limit).
    @Query("SELECT c.postId FROM Comment c WHERE c.userId = :userId AND c.deletedAt IS NULL ORDER BY c.createdAt DESC")
    List<UUID> findRecentPostIdsByUserId(@Param("userId") UUID userId, Pageable pageable);

    // Bulk equivalent of PostServiceImpl's per-comment softDelete — used only
    // by account deletion (see AccountDeletionService), which removes every
    // comment a deleted user ever left, not just one. clearAutomatically:
    // same reasoning as PostRepository's counter updates — a bulk UPDATE
    // bypasses the persistence context, so anything already loaded in this
    // transaction needs the context cleared to see the change.
    @Modifying(clearAutomatically = true)
    @Query("UPDATE Comment c SET c.deletedAt = :now WHERE c.userId = :userId AND c.deletedAt IS NULL")
    void softDeleteAllByUserId(@Param("userId") UUID userId, @Param("now") Instant now);
}
