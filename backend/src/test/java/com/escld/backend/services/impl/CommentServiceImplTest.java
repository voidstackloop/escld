package com.escld.backend.services.impl;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.cache.CacheManager;

import com.escld.backend.analytics.AnalyticsEventPublisher;
import com.escld.backend.entities.Comment;
import com.escld.backend.exceptions.NotCommentOwnerException;
import com.escld.backend.repo.CommentRepository;
import com.escld.backend.services.PostService;
import com.escld.backend.warehouse.WarehouseEventPublisher;

@ExtendWith(MockitoExtension.class)
class CommentServiceImplTest {

    @Mock private CommentRepository commentRepository;
    @Mock private PostService postService;
    @Mock private AnalyticsEventPublisher analyticsEventPublisher;
    @Mock private WarehouseEventPublisher warehouseEventPublisher;
    @Mock private CacheManager cacheManager;

    private CommentServiceImpl service;

    @BeforeEach
    void setUp() {
        service = new CommentServiceImpl(
                commentRepository, postService, analyticsEventPublisher, warehouseEventPublisher, cacheManager);
    }

    @Test
    void ownerDeletionPublishesCommentIdentityInsideTheTransaction() {
        UUID ownerId = UUID.randomUUID();
        Comment comment = comment(ownerId);
        when(commentRepository.findById(comment.getId())).thenReturn(Optional.of(comment));
        when(commentRepository.saveAndFlush(comment)).thenReturn(comment);

        service.deleteComment(comment.getId(), ownerId);

        assertThat(comment.getDeletedAt()).isNotNull();
        verify(postService).decrementCommentCount(comment.getPostId());
        verify(warehouseEventPublisher).publishPostCommentDeleted(
                comment.getPostId(), comment.getId(), ownerId, ownerId, "owner");
    }

    @Test
    void moderatorDeletionKeepsTheCommentAuthorSeparateFromTheDeletionActor() {
        UUID authorId = UUID.randomUUID();
        UUID moderatorId = UUID.randomUUID();
        Comment comment = comment(authorId);
        when(commentRepository.findById(comment.getId())).thenReturn(Optional.of(comment));
        when(commentRepository.saveAndFlush(comment)).thenReturn(comment);

        service.deleteCommentAsModerator(comment.getId(), moderatorId);

        verify(warehouseEventPublisher).publishPostCommentDeleted(
                comment.getPostId(), comment.getId(), authorId, moderatorId, "moderator");
    }

    @Test
    void unauthorizedDeletionDoesNotChangeStateOrPublishAnEvent() {
        Comment comment = comment(UUID.randomUUID());
        when(commentRepository.findById(comment.getId())).thenReturn(Optional.of(comment));

        assertThatThrownBy(() -> service.deleteComment(comment.getId(), UUID.randomUUID()))
                .isInstanceOf(NotCommentOwnerException.class);

        assertThat(comment.getDeletedAt()).isNull();
        verify(commentRepository, never()).saveAndFlush(comment);
        verify(warehouseEventPublisher, never()).publishPostCommentDeleted(
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any());
    }

    private Comment comment(UUID authorId) {
        return Comment.builder()
                .id(UUID.randomUUID())
                .postId(UUID.randomUUID())
                .userId(authorId)
                .text("comment")
                .build();
    }
}
