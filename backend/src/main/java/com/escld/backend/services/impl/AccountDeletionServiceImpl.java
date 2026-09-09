package com.escld.backend.services.impl;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.cache.CacheManager;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.escld.backend.entities.Post;
import com.escld.backend.entities.Comment;
import com.escld.backend.entities.User;
import com.escld.backend.exceptions.UserNotFoundException;
import com.escld.backend.feed.FeedStore;
import com.escld.backend.follow.FollowGraphStore;
import com.escld.backend.hide.HideStore;
import com.escld.backend.like.LikeStore;
import com.escld.backend.metrics.EmfMetrics;
import com.escld.backend.repo.CommentRepository;
import com.escld.backend.repo.PostRepository;
import com.escld.backend.repo.UserRepository;
import com.escld.backend.search.PostSearchDocument;
import com.escld.backend.search.PostSearchRepository;
import com.escld.backend.search.UserSearchIndexer;
import com.escld.backend.services.AccountDeletionService;
import com.escld.backend.user.UserStatus;
import com.escld.backend.warehouse.WarehouseEventPublisher;

import lombok.extern.slf4j.Slf4j;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.Delete;
import software.amazon.awssdk.services.s3.model.DeleteObjectsRequest;
import software.amazon.awssdk.services.s3.model.ObjectIdentifier;

/**
 * See AccountDeletionService's javadoc for scope (what's covered, what's
 * deliberately excluded).
 *
 * Ordering is deliberate: every DynamoDB/Elasticsearch/S3 operation below is
 * naturally idempotent (deleting an already-deleted item, or one that was
 * never there, is a no-op), so they all run BEFORE the single Postgres
 * transaction that soft-deletes this user's posts/comments and anonymizes
 * their row. If any of those cross-store calls fails, nothing has been
 * committed anywhere that a Postgres rollback would need to reason about,
 * and the whole call is safe to retry from scratch. If the Postgres
 * transaction itself is the thing that fails, everything before it already
 * succeeded and won't be redone unnecessarily on a retry — this is the one
 * genuinely irreversible step, so it happens last, not first.
 */
@Slf4j
@Service
public class AccountDeletionServiceImpl implements AccountDeletionService {

    private final UserRepository userRepository;
    private final PostRepository postRepository;
    private final CommentRepository commentRepository;
    private final FollowGraphStore followGraphStore;
    private final LikeStore likeStore;
    private final HideStore hideStore;
    private final FeedStore feedStore;
    private final PostSearchRepository postSearchRepository;
    private final UserSearchIndexer userSearchIndexer;
    private final S3Client s3Client;
    private final CacheManager cacheManager;
    private final EmfMetrics emfMetrics;
    private final WarehouseEventPublisher warehouseEventPublisher;
    private final String bucketName;
    private final String cloudfrontDomain;

    @Autowired
    public AccountDeletionServiceImpl(
            UserRepository userRepository,
            PostRepository postRepository,
            CommentRepository commentRepository,
            FollowGraphStore followGraphStore,
            LikeStore likeStore,
            HideStore hideStore,
            FeedStore feedStore,
            PostSearchRepository postSearchRepository,
            UserSearchIndexer userSearchIndexer,
            S3Client s3Client,
            CacheManager cacheManager,
            EmfMetrics emfMetrics,
            WarehouseEventPublisher warehouseEventPublisher,
            @Value("${app.media.bucket-name}") String bucketName,
            @Value("${app.media.cloudfront-domain}") String cloudfrontDomain) {
        this.userRepository = userRepository;
        this.postRepository = postRepository;
        this.commentRepository = commentRepository;
        this.followGraphStore = followGraphStore;
        this.likeStore = likeStore;
        this.hideStore = hideStore;
        this.feedStore = feedStore;
        this.postSearchRepository = postSearchRepository;
        this.userSearchIndexer = userSearchIndexer;
        this.s3Client = s3Client;
        this.cacheManager = cacheManager;
        this.emfMetrics = emfMetrics;
        this.warehouseEventPublisher = warehouseEventPublisher;
        this.bucketName = bucketName;
        this.cloudfrontDomain = cloudfrontDomain;
    }

    /** Compatibility constructor for focused tests that do not exercise warehouse events. */
    public AccountDeletionServiceImpl(
            UserRepository userRepository,
            PostRepository postRepository,
            CommentRepository commentRepository,
            FollowGraphStore followGraphStore,
            LikeStore likeStore,
            HideStore hideStore,
            FeedStore feedStore,
            PostSearchRepository postSearchRepository,
            UserSearchIndexer userSearchIndexer,
            S3Client s3Client,
            CacheManager cacheManager,
            EmfMetrics emfMetrics,
            String bucketName,
            String cloudfrontDomain) {
        this(userRepository, postRepository, commentRepository, followGraphStore, likeStore, hideStore, feedStore,
                postSearchRepository, userSearchIndexer, s3Client, cacheManager, emfMetrics, null,
                bucketName, cloudfrontDomain);
    }

    @Override
    @Transactional
    public void deleteAccount(UUID userId) {
        User user = userRepository.findById(userId).orElseThrow(() -> new UserNotFoundException(userId));
        String originalUsername = user.getUsername();
        UUID cognitoSub = user.getCognitoSub();

        // Suppression ledger first: relays and replay jobs consult it so old
        // events cannot recreate deleted records. Published before derived
        // state removal; completed marker follows after anonymization.
        if (warehouseEventPublisher != null) {
            warehouseEventPublisher.publishUserDeletionRequested(userId);
        }

        List<Post> posts = postRepository.findAllActiveByUserId(userId);
        List<Comment> activeComments = commentRepository.findAllByUserIdAndDeletedAtIsNull(userId);

        // Followers must be captured before unfollowAll runs below — fan-out
        // feed items live under each follower's own partition, keyed by this
        // author's posts, not under this author's own partition.
        List<UUID> followers = followGraphStore.listFollowers(userId);
        for (Post post : posts) {
            for (UUID followerId : followers) {
                feedStore.removePost(followerId, post.getCreatedAt(), post.getId());
            }
        }

        List<String> mediaKeys = new ArrayList<>();
        for (Post post : posts) {
            if (post.getMediaKey() != null && !post.getMediaKey().isBlank()) {
                mediaKeys.add(post.getMediaKey());
            }
        }
        mediaKeys.addAll(extractOwnedS3Keys(user));
        deleteS3Objects(mediaKeys);

        List<PostSearchDocument> postDocs = postSearchRepository.findByUserIdOrderByCreatedAtDesc(userId.toString());
        if (!postDocs.isEmpty()) {
            postSearchRepository.deleteAll(postDocs);
        }
        userSearchIndexer.delete(user);

        followGraphStore.unfollowAll(userId);
        likeStore.unlikeAll(userId);
        hideStore.unhideAll(userId);
        feedStore.deleteAllForOwner(userId);

        // The one genuinely irreversible step, and the only part that touches
        // a transactional resource — deliberately last, per this class's own
        // doc comment above.
        Instant now = Instant.now();
        for (Post post : posts) {
            post.setDeletedAt(now);
        }
        // Flush before the comment bulk update below: that query is
        // @Modifying(clearAutomatically = true), which clears the whole
        // persistence context — including these just-mutated, not-yet-
        // flushed Post entities. Without an explicit flush here, their
        // deletedAt change is silently discarded (never reaches the
        // database) the moment the context is cleared, since a clear
        // (unlike a rollback) doesn't itself trigger a flush first.
        postRepository.saveAll(posts);
        postRepository.flush();
        commentRepository.softDeleteAllByUserId(user.getId(), now);
        if (warehouseEventPublisher != null) {
            for (Comment comment : activeComments) {
                warehouseEventPublisher.publishPostCommentDeleted(
                        comment.getPostId(), comment.getId(), userId, userId, "account_deletion");
            }
        }
        anonymize(user, now);
        userRepository.save(user);

        evictCaches(userId, originalUsername, cognitoSub);
        if (warehouseEventPublisher != null) {
            List<String> ownedPostIds = posts.stream().map(p -> p.getId().toString()).toList();
            warehouseEventPublisher.publishUserDeletionCompleted(userId, ownedPostIds);
        }
        emfMetrics.increment("account_deletions_total", Map.of());
        log.info("Deleted account {}", userId);
    }

    /**
     * Scrubs directly-identifying fields in place rather than hard-deleting
     * the row — posts/comments have an FK to users.id, and CognitoSub itself
     * is `updatable = false` at the JPA level (see User entity), so it's left
     * untouched here on purpose: actually deleting the underlying Cognito
     * identity is a separate action against Cognito itself, out of this
     * capability's scope (see AccountDeletionService's javadoc).
     */
    private void anonymize(User user, Instant now) {
        String tombstone = "deleted_" + user.getId().toString().replace("-", "").substring(0, 20);
        user.setUsername(tombstone);
        user.setEmail("deleted+" + user.getId() + "@deleted.escld.invalid");
        user.setDisplayName("Deleted user");
        user.setBio(null);
        user.setAvatarUrl(null);
        user.setCoverImageUrl(null);
        user.setLocation(null);
        user.setWebsiteUrl(null);
        user.setBirthdate(null);
        user.setStatus(UserStatus.DEACTIVATED);
        user.setFollowersCount(0);
        user.setFollowingCount(0);
        user.setPostsCount(0);
        user.setDeletedAt(now);
    }

    private List<String> extractOwnedS3Keys(User user) {
        List<String> keys = new ArrayList<>();
        String prefix = "https://" + cloudfrontDomain + "/";
        if (user.getAvatarUrl() != null && user.getAvatarUrl().startsWith(prefix)) {
            keys.add(user.getAvatarUrl().substring(prefix.length()));
        }
        if (user.getCoverImageUrl() != null && user.getCoverImageUrl().startsWith(prefix)) {
            keys.add(user.getCoverImageUrl().substring(prefix.length()));
        }
        return keys;
    }

    private void deleteS3Objects(List<String> keys) {
        if (keys.isEmpty()) {
            return;
        }
        // S3 DeleteObjects caps at 1000 keys per request.
        for (int i = 0; i < keys.size(); i += 1000) {
            List<ObjectIdentifier> ids = keys.subList(i, Math.min(i + 1000, keys.size())).stream()
                    .map(key -> ObjectIdentifier.builder().key(key).build())
                    .toList();
            s3Client.deleteObjects(DeleteObjectsRequest.builder()
                    .bucket(bucketName)
                    .delete(Delete.builder().objects(ids).build())
                    .build());
        }
    }

    private void evictCaches(UUID userId, String originalUsername, UUID cognitoSub) {
        evict("usersById", userId.toString());
        evict("usersByUsername", originalUsername.toLowerCase());
        evict("usersByCognitoSub", cognitoSub.toString());
    }

    private void evict(String cacheName, String key) {
        var cache = cacheManager.getCache(cacheName);
        if (cache != null) {
            cache.evict(key);
        }
    }
}
