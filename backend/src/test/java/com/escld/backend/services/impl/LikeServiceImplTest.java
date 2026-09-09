package com.escld.backend.services.impl;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import com.escld.backend.analytics.AnalyticsEventPublisher;
import com.escld.backend.counters.CounterProjectionService;
import com.escld.backend.dto.LikeResponse;
import com.escld.backend.entities.Post;
import com.escld.backend.like.LikeStore;
import com.escld.backend.services.PostService;
import com.escld.backend.warehouse.WarehouseEventPublisher;

@ExtendWith(MockitoExtension.class)
class LikeServiceImplTest {

    @Mock
    private LikeStore likeStore;
    @Mock
    private PostService postService;
    @Mock
    private AnalyticsEventPublisher analyticsEventPublisher;
    @Mock
    private WarehouseEventPublisher warehouseEventPublisher;
    @Mock
    private CounterProjectionService counterProjections;

    @InjectMocks
    private LikeServiceImpl likeService;

    private final UUID postId = UUID.randomUUID();
    private final UUID userId = UUID.randomUUID();

    @Test
    void likingForTheFirstTimeInsertsAndIncrements() {
        when(postService.getById(postId)).thenReturn(postWithLikeCount(1));
        when(likeStore.like(eq(postId), eq(userId), any())).thenReturn(true);
        when(counterProjections.tryClaim(any(), eq(CounterProjectionService.PROJECTION_VERSION), any()))
                .thenReturn(true);

        LikeResponse response = likeService.like(postId, userId);

        verify(postService).incrementLikeCount(postId);
        assertThat(response.liked()).isTrue();
        assertThat(response.likeCount()).isEqualTo(1);
    }

    @Test
    void likingAnAlreadyLikedPostIsIdempotentAndDoesNotDoubleIncrement() {
        when(postService.getById(postId)).thenReturn(postWithLikeCount(5));
        when(likeStore.like(eq(postId), eq(userId), any())).thenReturn(false);

        LikeResponse response = likeService.like(postId, userId);

        verify(postService, never()).incrementLikeCount(postId);
        assertThat(response.liked()).isTrue();
        assertThat(response.likeCount()).isEqualTo(5);
    }

    @Test
    void replayedCounterClaimDoesNotDoubleIncrement() {
        when(postService.getById(postId)).thenReturn(postWithLikeCount(1));
        when(likeStore.like(eq(postId), eq(userId), any())).thenReturn(true);
        when(counterProjections.tryClaim(any(), eq(CounterProjectionService.PROJECTION_VERSION), any()))
                .thenReturn(false);

        LikeResponse response = likeService.like(postId, userId);

        verify(postService, never()).incrementLikeCount(postId);
        assertThat(response.liked()).isTrue();
    }

    @Test
    void unlikingARealLikeDeletesAndDecrements() {
        when(postService.getById(postId)).thenReturn(postWithLikeCount(0));
        when(likeStore.unlike(eq(postId), eq(userId), any())).thenReturn(true);
        when(counterProjections.tryClaim(any(), eq(CounterProjectionService.PROJECTION_VERSION), any()))
                .thenReturn(true);

        LikeResponse response = likeService.unlike(postId, userId);

        verify(postService).decrementLikeCount(postId);
        assertThat(response.liked()).isFalse();
        assertThat(response.likeCount()).isEqualTo(0);
    }

    @Test
    void unlikingSomethingNeverLikedIsANoOp() {
        when(postService.getById(postId)).thenReturn(postWithLikeCount(3));
        when(likeStore.unlike(eq(postId), eq(userId), any())).thenReturn(false);

        LikeResponse response = likeService.unlike(postId, userId);

        verify(postService, never()).decrementLikeCount(postId);
        assertThat(response.liked()).isFalse();
        assertThat(response.likeCount()).isEqualTo(3);
    }

    private Post postWithLikeCount(int likeCount) {
        return Post.builder().id(postId).likeCount(likeCount).build();
    }
}
