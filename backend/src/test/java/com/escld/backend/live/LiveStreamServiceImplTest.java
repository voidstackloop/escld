package com.escld.backend.live;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import com.escld.backend.analytics.AnalyticsEventPublisher;
import com.escld.backend.dto.StartLiveStreamRequest;
import com.escld.backend.entities.Post;
import com.escld.backend.entities.User;
import com.escld.backend.exceptions.InvalidPostException;
import com.escld.backend.exceptions.UserNotFoundException;
import com.escld.backend.feed.PostEventPublisher;
import com.escld.backend.metrics.EmfMetrics;
import com.escld.backend.post.LiveStatus;
import com.escld.backend.post.PostMediaStatus;
import com.escld.backend.post.PostMediaType;
import com.escld.backend.repo.PostRepository;
import com.escld.backend.repo.UserRepository;
import com.escld.backend.warehouse.WarehouseEventPublisher;

@ExtendWith(MockitoExtension.class)
class LiveStreamServiceImplTest {

    private static final String CLOUDFRONT_DOMAIN = "media.example.com";

    @Mock
    private PostRepository postRepository;
    @Mock
    private UserRepository userRepository;
    @Mock
    private PostEventPublisher postEventPublisher;
    @Mock
    private AnalyticsEventPublisher analyticsEventPublisher;
    @Mock
    private WarehouseEventPublisher warehouseEventPublisher;
    @Mock
    private LiveViewerPresenceService liveViewerPresenceService;
    @Mock
    private EmfMetrics emfMetrics;

    private LiveStreamServiceImpl service;

    private LiveStreamServiceImpl service() {
        return new LiveStreamServiceImpl(
                postRepository, userRepository, postEventPublisher, analyticsEventPublisher, warehouseEventPublisher,
                liveViewerPresenceService, emfMetrics, CLOUDFRONT_DOMAIN);
    }

    @Test
    void getActiveStreamReturnsTheCallersCurrentLivePostWhenOneExists() {
        service = service();
        UUID userId = UUID.randomUUID();
        Post live = Post.builder().id(UUID.randomUUID()).userId(userId).liveStatus(LiveStatus.LIVE).build();
        when(postRepository.findLiveByUserId(userId)).thenReturn(Optional.of(live));

        assertThat(service.getActiveStream(userId)).contains(live);
    }

    @Test
    void getActiveStreamIsEmptyWhenTheCallerIsNotCurrentlyLive() {
        service = service();
        UUID userId = UUID.randomUUID();
        when(postRepository.findLiveByUserId(userId)).thenReturn(Optional.empty());

        assertThat(service.getActiveStream(userId)).isEmpty();
    }

    @Test
    void startingAStreamCreatesALiveMediaTypePostWithARealMediaUrlAndFansItOutThroughTheExistingPostPipeline() {
        service = service();
        UUID userId = UUID.randomUUID();
        UUID streamKey = UUID.randomUUID();
        when(postRepository.findLiveByUserId(userId)).thenReturn(Optional.empty());
        when(userRepository.findById(userId)).thenReturn(Optional.of(User.builder().id(userId).streamKey(streamKey).build()));
        when(postRepository.saveAndFlush(any(Post.class))).thenAnswer(inv -> inv.getArgument(0));

        Post result = service.start(userId, new StartLiveStreamRequest("My stream", "desc", List.of("Gaming")));

        assertThat(result.getMediaType()).isEqualTo(PostMediaType.LIVE);
        assertThat(result.getMediaStatus()).isEqualTo(PostMediaStatus.PROCESSING);
        assertThat(result.getMediaUrl()).isEqualTo("https://media.example.com/live/" + streamKey + "/live.m3u8");
        assertThat(result.getLiveStatus()).isEqualTo(LiveStatus.LIVE);
        assertThat(result.getText()).isEqualTo("My stream");
        assertThat(result.getDescription()).isEqualTo("desc");
        assertThat(result.getTags()).containsExactly("gaming");
        assertThat(result.getLiveStartedAt()).isNotNull();

        verify(postEventPublisher).publishCreated(result);
        verify(analyticsEventPublisher).publishPostCreated(eq(result.getId()), eq(userId), eq(Set.of("gaming")));
        verify(warehouseEventPublisher).publishLiveStarted(result.getId(), userId, "My stream");
    }

    @Test
    void refusesToStartASecondStreamWhileOneIsAlreadyLive() {
        service = service();
        UUID userId = UUID.randomUUID();
        Post existing = Post.builder().id(UUID.randomUUID()).userId(userId).liveStatus(LiveStatus.LIVE).build();
        when(postRepository.findLiveByUserId(userId)).thenReturn(Optional.of(existing));

        assertThatThrownBy(() -> service.start(userId, new StartLiveStreamRequest("t", null, null)))
                .isInstanceOf(InvalidPostException.class);

        verify(postRepository, never()).saveAndFlush(any());
        verify(postEventPublisher, never()).publishCreated(any());
    }

    @Test
    void refusesToStartAStreamWithNoStreamKeyGenerated() {
        service = service();
        UUID userId = UUID.randomUUID();
        when(postRepository.findLiveByUserId(userId)).thenReturn(Optional.empty());
        when(userRepository.findById(userId)).thenReturn(Optional.of(User.builder().id(userId).streamKey(null).build()));

        assertThatThrownBy(() -> service.start(userId, new StartLiveStreamRequest("t", null, null)))
                .isInstanceOf(InvalidPostException.class);

        verify(postRepository, never()).saveAndFlush(any());
        verify(postEventPublisher, never()).publishCreated(any());
    }

    @Test
    void startingAStreamForAnUnresolvableUserFailsClearlyRatherThanNullPointing() {
        service = service();
        UUID userId = UUID.randomUUID();
        when(postRepository.findLiveByUserId(userId)).thenReturn(Optional.empty());
        when(userRepository.findById(userId)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.start(userId, new StartLiveStreamRequest("t", null, null)))
                .isInstanceOf(UserNotFoundException.class);
    }

    @Test
    void endingAStreamMarksItEndedAndPublishesTheDurationAndPeakViewersToTheWarehouse() {
        service = service();
        UUID userId = UUID.randomUUID();
        UUID postId = UUID.randomUUID();
        Instant startedAt = Instant.now().minusSeconds(90);
        Post live = Post.builder().id(postId).userId(userId).liveStatus(LiveStatus.LIVE).liveStartedAt(startedAt).build();
        when(postRepository.findLiveByUserId(userId)).thenReturn(Optional.of(live));
        when(liveViewerPresenceService.getPeakViewerCount(postId)).thenReturn(42);

        Post result = service.end(userId);

        assertThat(result.getLiveStatus()).isEqualTo(LiveStatus.ENDED);
        assertThat(result.getLiveEndedAt()).isNotNull();
        assertThat(result.getPeakViewerCount()).isEqualTo(42);
        verify(postRepository).endLiveStream(eq(postId), any(Instant.class), eq(42));

        ArgumentCaptor<Long> durationCaptor = ArgumentCaptor.forClass(Long.class);
        verify(warehouseEventPublisher).publishLiveEnded(eq(postId), eq(userId), durationCaptor.capture(), eq(42));
        assertThat(durationCaptor.getValue()).isGreaterThanOrEqualTo(90L);
        // Presence state is scoped to "while live" — leaving it around after
        // the stream ends would let a stale count linger in Redis forever.
        verify(liveViewerPresenceService).clear(postId);
    }

    @Test
    void refusesToEndAStreamThatIsNotLive() {
        service = service();
        UUID userId = UUID.randomUUID();
        when(postRepository.findLiveByUserId(userId)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.end(userId)).isInstanceOf(InvalidPostException.class);
        verify(warehouseEventPublisher, never()).publishLiveEnded(any(), any(), anyLong(), anyInt());
    }
}
