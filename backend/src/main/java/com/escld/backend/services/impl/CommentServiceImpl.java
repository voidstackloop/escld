package com.escld.backend.services.impl;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.springframework.cache.CacheManager;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.escld.backend.analytics.AnalyticsEventPublisher;
import com.escld.backend.entities.Comment;
import com.escld.backend.entities.Post;
import com.escld.backend.exceptions.CommentNotFoundException;
import com.escld.backend.exceptions.NotCommentOwnerException;
import com.escld.backend.repo.CommentRepository;
import com.escld.backend.services.CommentService;
import com.escld.backend.services.PostService;
import com.escld.backend.warehouse.WarehouseEventPublisher;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

@Slf4j
@Service
@RequiredArgsConstructor
public class CommentServiceImpl implements CommentService {

    private final CommentRepository commentRepository;
    private final PostService postService;
    private final AnalyticsEventPublisher analyticsEventPublisher;
    private final WarehouseEventPublisher warehouseEventPublisher;
    private final CacheManager cacheManager;

    @Override
    public Comment getById(UUID commentId) {
        return commentRepository.findById(commentId)
                .filter(c -> c.getDeletedAt() == null)
                .orElseThrow(() -> new CommentNotFoundException(commentId));
    }

    @Override
    @Transactional
    @CacheEvict(cacheNames = "commentsByPostId", key = "#postId.toString()")
    public Comment createComment(UUID postId, UUID authorId, String text) {
        Post post = postService.getById(postId);

        // saveAndFlush, not save — same clearAutomatically-wipes-the-pending-insert
        // bug as PostServiceImpl.createPost (see its comment): incrementCommentCount
        // below is a clearAutomatically=true bulk UPDATE and would silently discard
        // this comment's not-yet-flushed INSERT otherwise.
        Comment saved = commentRepository.saveAndFlush(Comment.builder()
                .postId(postId)
                .userId(authorId)
                .text(text)
                .build());

        // Through PostService, not PostRepository directly — keeps postsById
        // (see PostServiceImpl#getById) evicted alongside commentCount too.
        postService.incrementCommentCount(post.getId());
        analyticsEventPublisher.publishPostCommented(post.getId());
        warehouseEventPublisher.publishPostCommented(post.getId(), saved.getId(), authorId);

        return saved;
    }

    @Override
    @Cacheable(cacheNames = "commentsByPostId", key = "#postId.toString()")
    public List<Comment> getByPostId(UUID postId) {
        postService.getById(postId);
        return commentRepository.findByPostIdOrderByCreatedAtDesc(postId);
    }

    @Override
    @Transactional
    public void deleteComment(UUID commentId, UUID requesterId) {
        Comment comment = commentRepository.findById(commentId)
                .filter(c -> c.getDeletedAt() == null)
                .orElseThrow(() -> new CommentNotFoundException(commentId));

        if (!comment.getUserId().equals(requesterId)) {
            throw new NotCommentOwnerException();
        }

        softDelete(comment, requesterId, "owner");
        log.info("Comment {} deleted by owner {}", commentId, requesterId);
    }

    @Override
    @Transactional
    public void deleteCommentAsModerator(UUID commentId, UUID moderatorId) {
        softDelete(getById(commentId), moderatorId, "moderator");
        log.info("Comment {} deleted by a moderator", commentId);
    }

    private void softDelete(Comment comment, UUID deletedById, String deletionReason) {
        comment.setDeletedAt(Instant.now());
        // Same reasoning as createComment above — flush before the clearAutomatically call.
        commentRepository.saveAndFlush(comment);

        postService.decrementCommentCount(comment.getPostId());
        warehouseEventPublisher.publishPostCommentDeleted(
                comment.getPostId(), comment.getId(), comment.getUserId(), deletedById, deletionReason);

        // softDelete() is private and called from within this same class
        // (deleteComment/deleteCommentAsModerator), so a declarative
        // @CacheEvict here would never fire — Spring's cache AOP proxy can't
        // intercept a self-invoked call. commentsByPostId's cache key
        // (postId) also isn't a parameter of either public caller (they only
        // have commentId), so annotating them declaratively isn't an option
        // either, unlike PostServiceImpl's equivalent case. Evicting
        // directly via CacheManager works regardless of self-invocation,
        // since it's plain imperative code, not AOP.
        var cache = cacheManager.getCache("commentsByPostId");
        if (cache != null) {
            cache.evict(comment.getPostId().toString());
        }
    }
}
