package com.escld.backend.services.impl;

import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.escld.backend.analytics.AnalyticsEventPublisher;
import com.escld.backend.dto.CreatePostRequest;
import com.escld.backend.entities.Post;
import com.escld.backend.entities.User;
import com.escld.backend.exceptions.InvalidPostException;
import com.escld.backend.exceptions.NotPostOwnerException;
import com.escld.backend.exceptions.PostNotFoundException;
import com.escld.backend.metrics.EmfMetrics;
import com.escld.backend.post.PostMediaStatus;
import com.escld.backend.post.PostMediaType;
import com.escld.backend.post.PostPage;
import com.escld.backend.post.TagNormalizer;
import com.escld.backend.feed.PostEventPublisher;
import com.escld.backend.repo.PostRepository;
import com.escld.backend.services.PostService;
import com.escld.backend.services.UserService;
import com.escld.backend.transcode.TranscodeJobPublisher;
import com.escld.backend.warehouse.WarehouseEventPublisher;

import lombok.extern.slf4j.Slf4j;

@Slf4j
@Service
public class PostServiceImpl implements PostService {

    private final PostRepository postRepository;
    private final UserService userService;
    private final TranscodeJobPublisher transcodeJobPublisher;
    private final PostEventPublisher postEventPublisher;
    private final AnalyticsEventPublisher analyticsEventPublisher;
    private final WarehouseEventPublisher warehouseEventPublisher;
    private final EmfMetrics emfMetrics;
    private final String cloudfrontDomain;

    public PostServiceImpl(
            PostRepository postRepository,
            UserService userService,
            TranscodeJobPublisher transcodeJobPublisher,
            PostEventPublisher postEventPublisher,
            AnalyticsEventPublisher analyticsEventPublisher,
            WarehouseEventPublisher warehouseEventPublisher,
            EmfMetrics emfMetrics,
            @Value("${app.media.cloudfront-domain}") String cloudfrontDomain) {
        this.postRepository = postRepository;
        this.userService = userService;
        this.transcodeJobPublisher = transcodeJobPublisher;
        this.postEventPublisher = postEventPublisher;
        this.analyticsEventPublisher = analyticsEventPublisher;
        this.warehouseEventPublisher = warehouseEventPublisher;
        this.emfMetrics = emfMetrics;
        this.cloudfrontDomain = cloudfrontDomain;
    }

    @Override
    @Transactional
    public Post createPost(UUID authorId, CreatePostRequest request) {
        boolean hasText = request.text() != null && !request.text().isBlank();
        boolean hasMedia = request.mediaKey() != null && !request.mediaKey().isBlank();

        if (!hasText && !hasMedia) {
            throw new InvalidPostException("A post needs text, media, or both");
        }
        if (hasMedia && request.mediaType() == null) {
            throw new InvalidPostException("mediaType is required when mediaKey is provided");
        }
        // LIVE posts are only ever created by LiveStreamService.start — they
        // have no mediaKey (nothing was uploaded), and creating one here
        // would produce a Post with mediaType=LIVE but liveStatus left null,
        // which the posts_one_live_per_user_idx partial unique index
        // (only enforced when live_status='LIVE') would silently let through
        // unlimited times.
        if (request.mediaType() == PostMediaType.LIVE) {
            throw new InvalidPostException("Use POST /api/v1/live/streams to start a live stream, not this endpoint");
        }

        Post.PostBuilder post = Post.builder()
                .userId(authorId)
                .text(hasText ? request.text() : null)
                .tags(TagNormalizer.normalize(request.tags()));

        if (hasMedia) {
            post.mediaType(request.mediaType()).mediaKey(request.mediaKey());

            if (request.mediaType() == PostMediaType.IMAGE) {
                // Images need no processing — servable straight from the presigned upload.
                post.mediaUrl("https://" + cloudfrontDomain + "/" + request.mediaKey())
                        .mediaStatus(PostMediaStatus.READY);
            } else {
                post.mediaStatus(PostMediaStatus.PROCESSING);
            }
        }

        // saveAndFlush, not save: incrementPostsCount below is a clearAutomatically=true
        // bulk UPDATE (see UserRepository) — it wipes the persistence context, which
        // would silently discard this post's still-pending (write-behind) INSERT if it
        // hasn't been flushed to the database yet. Confirmed live: without the explicit
        // flush here, createPost returned 201 with a real-looking post body, but no row
        // ever reached Postgres.
        Post saved = postRepository.saveAndFlush(post.build());

        if (hasMedia && request.mediaType() != PostMediaType.IMAGE) {
            transcodeJobPublisher.publish(saved.getId(), request.mediaKey(), request.mediaType());
        }

        userService.incrementPostsCount(authorId);

        postEventPublisher.publishCreated(saved);
        analyticsEventPublisher.publishPostCreated(saved.getId(), authorId, saved.getTags());
        warehouseEventPublisher.publishPostCreated(saved.getId(), authorId);
        emfMetrics.increment("posts_created_total",
                Map.of("mediaType", hasMedia ? request.mediaType().name() : "NONE"));

        return saved;
    }

    /**
     * Real bug found via local end-to-end browser testing, not a
     * hypothetical: even though Post.tags is EAGER-fetched, Hibernate still
     * wraps it in its own PersistentSet at load time — a plain Set<String>
     * only in the declared field type, not the actual runtime object. The
     * shared GenericJackson2JsonRedisSerializer (see CacheConfig) uses
     * Jackson's default typing, which serializes that PersistentSet under
     * its real Hibernate class name; deserializing it back on a later cache
     * hit then throws LazyInitializationException, since a freshly
     * reconstructed PersistentSet is "uninitialized" until a live Hibernate
     * session populates it, and this happens with no session in scope. Only
     * this cache is affected — User/Comment carry no collection fields — so
     * the collection is materialized into a plain LinkedHashSet right at the
     * @Cacheable boundary rather than reaching for a broader Hibernate-aware
     * Jackson module for the one field that actually needs it.
     */
    @Override
    @Cacheable(cacheNames = "postsById", key = "#postId.toString()")
    public Post getById(UUID postId) {
        Post post = postRepository.findById(postId)
                .filter(p -> p.getDeletedAt() == null)
                .orElseThrow(() -> new PostNotFoundException(postId));
        post.setTags(new LinkedHashSet<>(post.getTags()));
        return post;
    }

    @Override
    public PostPage getByUsername(String username, int limit, String cursor) {
        User author = userService.getByUsername(username);
        Pageable pageable = PageRequest.of(0, limit);

        List<Post> posts;
        if (cursor == null || cursor.isBlank()) {
            posts = postRepository.findFirstPageByUserId(author.getId(), pageable);
        } else {
            // cursor = "<createdAt>|<postId>" — id is a tiebreaker so posts
            // sharing the exact same createdAt (happens in practice) don't
            // get silently dropped at a page boundary.
            int separator = cursor.lastIndexOf('|');
            Instant cursorCreatedAt = Instant.parse(cursor.substring(0, separator));
            UUID cursorId = UUID.fromString(cursor.substring(separator + 1));
            posts = postRepository.findNextPageByUserId(author.getId(), cursorCreatedAt, cursorId, pageable);
        }

        String nextCursor = posts.size() == limit
                ? encodeCursor(posts.get(posts.size() - 1))
                : null;

        return new PostPage(posts, nextCursor);
    }

    private String encodeCursor(Post post) {
        return post.getCreatedAt().toString() + "|" + post.getId();
    }

    @Override
    @Transactional
    // softDelete() is private, so a @CacheEvict placed on it would never fire
    // (Spring's cache AOP proxy can't intercept a self-invoked private call)
    // — evicting here, on the public entry point, is what actually works.
    @CacheEvict(cacheNames = "postsById", key = "#postId.toString()")
    public void deletePost(UUID postId, UUID requesterId) {
        Post post = getById(postId);
        if (!post.getUserId().equals(requesterId)) {
            throw new NotPostOwnerException();
        }

        softDelete(post);
        log.info("Post {} deleted by owner {}", postId, requesterId);
    }

    @Override
    @Transactional
    @CacheEvict(cacheNames = "postsById", key = "#postId.toString()")
    public void deletePostAsModerator(UUID postId) {
        softDelete(getById(postId));
        log.info("Post {} deleted by a moderator", postId);
    }

    private void softDelete(Post post) {
        post.setDeletedAt(Instant.now());
        // Same reasoning as createPost above — flush this update before
        // decrementPostsCount's clearAutomatically bulk query can discard it.
        postRepository.saveAndFlush(post);

        userService.decrementPostsCount(post.getUserId());
    }

    // See PostService's own doc comment on these four for why they exist
    // instead of callers touching PostRepository's counters directly.
    @Override
    @CacheEvict(cacheNames = "postsById", key = "#postId.toString()")
    public void incrementLikeCount(UUID postId) {
        postRepository.incrementLikeCount(postId);
    }

    @Override
    @CacheEvict(cacheNames = "postsById", key = "#postId.toString()")
    public void decrementLikeCount(UUID postId) {
        postRepository.decrementLikeCount(postId);
    }

    @Override
    @CacheEvict(cacheNames = "postsById", key = "#postId.toString()")
    public void incrementCommentCount(UUID postId) {
        postRepository.incrementCommentCount(postId);
    }

    @Override
    @CacheEvict(cacheNames = "postsById", key = "#postId.toString()")
    public void decrementCommentCount(UUID postId) {
        postRepository.decrementCommentCount(postId);
    }
}
