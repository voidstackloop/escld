package com.escld.backend.live;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

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
import com.escld.backend.post.TagNormalizer;
import com.escld.backend.repo.PostRepository;
import com.escld.backend.repo.UserRepository;
import com.escld.backend.warehouse.WarehouseEventPublisher;

import lombok.extern.slf4j.Slf4j;

/**
 * A live stream is a real Post (mediaType=LIVE) — see LiveStreamService's
 * own doc for why. `start`/`end` deliberately mirror
 * PostServiceImpl.createPost's own publish sequence (postEventPublisher,
 * analyticsEventPublisher, warehouseEventPublisher, an EMF counter) rather
 * than inventing a separate one, since going live and posting are the same
 * underlying "a new thing appeared, tell every downstream consumer" action.
 */
@Slf4j
@Service
public class LiveStreamServiceImpl implements LiveStreamService {

    private final PostRepository postRepository;
    private final UserRepository userRepository;
    private final PostEventPublisher postEventPublisher;
    private final AnalyticsEventPublisher analyticsEventPublisher;
    private final WarehouseEventPublisher warehouseEventPublisher;
    private final LiveViewerPresenceService liveViewerPresenceService;
    private final EmfMetrics emfMetrics;
    private final String cloudfrontDomain;

    // Explicit constructor, not @RequiredArgsConstructor — @Value has to sit
    // on a constructor parameter directly (same reason PostServiceImpl's own
    // constructor is explicit), which Lombok's generated one can't carry.
    public LiveStreamServiceImpl(
            PostRepository postRepository,
            UserRepository userRepository,
            PostEventPublisher postEventPublisher,
            AnalyticsEventPublisher analyticsEventPublisher,
            WarehouseEventPublisher warehouseEventPublisher,
            LiveViewerPresenceService liveViewerPresenceService,
            EmfMetrics emfMetrics,
            @Value("${app.media.cloudfront-domain}") String cloudfrontDomain) {
        this.postRepository = postRepository;
        this.userRepository = userRepository;
        this.postEventPublisher = postEventPublisher;
        this.analyticsEventPublisher = analyticsEventPublisher;
        this.warehouseEventPublisher = warehouseEventPublisher;
        this.liveViewerPresenceService = liveViewerPresenceService;
        this.emfMetrics = emfMetrics;
        this.cloudfrontDomain = cloudfrontDomain;
    }

    @Override
    public Optional<Post> getActiveStream(UUID userId) {
        return postRepository.findLiveByUserId(userId);
    }

    @Override
    @Transactional
    public Post start(UUID userId, StartLiveStreamRequest request) {
        if (postRepository.findLiveByUserId(userId).isPresent()) {
            throw new InvalidPostException("You already have an active live stream — end it before starting a new one");
        }

        User user = userRepository.findById(userId).orElseThrow(() -> new UserNotFoundException(userId));
        if (user.getStreamKey() == null) {
            throw new InvalidPostException("Generate a stream key before going live");
        }

        // The URL is deterministic from the stream key, so it's known — and
        // set — at announce time, before any encoder has connected: the RTMP
        // server writes its live HLS output to exactly this S3/CloudFront
        // path once publishing actually starts (see rtmp/src/s3_sync.rs).
        // mediaStatus stays PROCESSING until then (flipped to READY by
        // rtmp/src/store/postgres.rs's mark_media_ready, called from
        // start_publish) — the frontend's existing PROCESSING/READY branch
        // (post-card.tsx's PostMedia) shows a placeholder until there's real
        // output behind this URL, then the actual <video> element.
        String mediaUrl = "https://" + cloudfrontDomain + "/live/" + user.getStreamKey() + "/live.m3u8";

        Post post = Post.builder()
                .userId(userId)
                .text(request.title())
                .description(request.description())
                .mediaType(PostMediaType.LIVE)
                .mediaUrl(mediaUrl)
                .mediaStatus(PostMediaStatus.PROCESSING)
                .liveStatus(LiveStatus.LIVE)
                .liveStartedAt(Instant.now())
                .tags(TagNormalizer.normalize(request.tags()))
                .build();

        // saveAndFlush — same reasoning as PostServiceImpl.createPost: the
        // three publishers below all fire in the same request, and nothing
        // here does a clearAutomatically bulk UPDATE afterward the way
        // incrementPostsCount does, but flushing immediately still
        // guarantees `saved`'s DB-generated createdAt is populated before
        // postEventPublisher.publishCreated needs it.
        Post saved = postRepository.saveAndFlush(post);

        // Deliberately does NOT call userService.incrementPostsCount() —
        // announcing a stream isn't "posting content" in the profile-grid
        // sense a viewer expects that counter to reflect; it's ephemeral
        // and already visible via the live badge (once the frontend adds
        // one) rather than the post grid.
        postEventPublisher.publishCreated(saved);
        analyticsEventPublisher.publishPostCreated(saved.getId(), userId, saved.getTags());
        warehouseEventPublisher.publishLiveStarted(saved.getId(), userId, request.title());
        emfMetrics.increment("live_streams_started_total", Map.of());

        log.info("User {} started live stream {}", userId, saved.getId());
        return saved;
    }

    @Override
    @Transactional
    public Post end(UUID userId) {
        Post live = postRepository.findLiveByUserId(userId)
                .orElseThrow(() -> new InvalidPostException("No active live stream to end"));

        Instant endedAt = Instant.now();
        int peakViewerCount = liveViewerPresenceService.getPeakViewerCount(live.getId());
        postRepository.endLiveStream(live.getId(), endedAt, peakViewerCount);

        long durationSeconds = Duration.between(live.getLiveStartedAt(), endedAt).getSeconds();
        warehouseEventPublisher.publishLiveEnded(live.getId(), userId, durationSeconds, peakViewerCount);
        liveViewerPresenceService.clear(live.getId());
        emfMetrics.increment("live_streams_ended_total", Map.of());

        log.info("User {} ended live stream {} after {}s, peak {} viewers", userId, live.getId(), durationSeconds, peakViewerCount);

        // clearAutomatically=true on endLiveStream (see PostRepository)
        // already wiped this entity from the persistence context — update
        // the in-memory copy the same way rather than re-fetching, since
        // the caller (LiveController) only needs it to build a response.
        live.setLiveStatus(LiveStatus.ENDED);
        live.setLiveEndedAt(endedAt);
        live.setPeakViewerCount(peakViewerCount);
        return live;
    }
}
