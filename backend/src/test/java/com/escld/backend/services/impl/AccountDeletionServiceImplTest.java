package com.escld.backend.services.impl;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;

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
import com.escld.backend.user.UserStatus;
import com.escld.backend.warehouse.WarehouseEventPublisher;

import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectsRequest;
import software.amazon.awssdk.services.s3.model.DeleteObjectsResponse;

@ExtendWith(MockitoExtension.class)
class AccountDeletionServiceImplTest {

    @Mock
    private UserRepository userRepository;
    @Mock
    private PostRepository postRepository;
    @Mock
    private CommentRepository commentRepository;
    @Mock
    private FollowGraphStore followGraphStore;
    @Mock
    private LikeStore likeStore;
    @Mock
    private HideStore hideStore;
    @Mock
    private FeedStore feedStore;
    @Mock
    private PostSearchRepository postSearchRepository;
    @Mock
    private UserSearchIndexer userSearchIndexer;
    @Mock
    private S3Client s3Client;
    @Mock
    private CacheManager cacheManager;
    @Mock
    private EmfMetrics emfMetrics;
    @Mock
    private WarehouseEventPublisher warehouseEventPublisher;
    @Mock
    private Cache cache;

    private AccountDeletionServiceImpl service;

    private final UUID userId = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        service = new AccountDeletionServiceImpl(
                userRepository, postRepository, commentRepository, followGraphStore, likeStore, hideStore, feedStore,
                postSearchRepository, userSearchIndexer, s3Client, cacheManager, emfMetrics, warehouseEventPublisher,
                "escld-media", "cdn.escld.example");
    }

    private User activeUser() {
        return User.builder()
                .id(userId)
                .cognitoSub(UUID.randomUUID())
                .username("someuser")
                .email("someuser@example.com")
                .displayName("Some User")
                .bio("bio text")
                .avatarUrl("https://cdn.escld.example/avatars/" + userId + "/pic.jpg")
                .coverImageUrl("https://cdn.escld.example/covers/" + userId + "/cover.jpg")
                .status(UserStatus.ACTIVE)
                .followersCount(5)
                .followingCount(3)
                .postsCount(2)
                .build();
    }

    @Test
    void throwsWhenTheUserDoesNotExist() {
        when(userRepository.findById(userId)).thenReturn(java.util.Optional.empty());

        assertThatThrownBy(() -> service.deleteAccount(userId)).isInstanceOf(UserNotFoundException.class);
        verify(postRepository, never()).findAllActiveByUserId(any());
    }

    @Test
    void removesTheDeletedUsersPostsFromEveryFollowersFeed() {
        User user = activeUser();
        when(userRepository.findById(userId)).thenReturn(java.util.Optional.of(user));
        Post post = Post.builder().id(UUID.randomUUID()).userId(userId).createdAt(Instant.now()).build();
        when(postRepository.findAllActiveByUserId(userId)).thenReturn(List.of(post));

        UUID follower1 = UUID.randomUUID();
        UUID follower2 = UUID.randomUUID();
        when(followGraphStore.listFollowers(userId)).thenReturn(List.of(follower1, follower2));
        when(cacheManager.getCache(any())).thenReturn(cache);

        service.deleteAccount(userId);

        verify(feedStore).removePost(follower1, post.getCreatedAt(), post.getId());
        verify(feedStore).removePost(follower2, post.getCreatedAt(), post.getId());
    }

    @Test
    void deletesPostMediaAndOwnedAvatarCoverObjectsFromS3() {
        User user = activeUser();
        when(userRepository.findById(userId)).thenReturn(java.util.Optional.of(user));
        Post post = Post.builder()
                .id(UUID.randomUUID())
                .userId(userId)
                .createdAt(Instant.now())
                .mediaKey("posts/" + userId + "/video.mp4")
                .build();
        when(postRepository.findAllActiveByUserId(userId)).thenReturn(List.of(post));
        when(followGraphStore.listFollowers(userId)).thenReturn(List.of());
        when(cacheManager.getCache(any())).thenReturn(cache);
        when(s3Client.deleteObjects(any(DeleteObjectsRequest.class)))
                .thenReturn(DeleteObjectsResponse.builder().build());

        service.deleteAccount(userId);

        var captor = org.mockito.ArgumentCaptor.forClass(DeleteObjectsRequest.class);
        verify(s3Client).deleteObjects(captor.capture());
        List<String> deletedKeys = captor.getValue().delete().objects().stream()
                .map(obj -> obj.key())
                .toList();
        assertThat(deletedKeys).containsExactlyInAnyOrder(
                "posts/" + userId + "/video.mp4",
                "avatars/" + userId + "/pic.jpg",
                "covers/" + userId + "/cover.jpg");
    }

    @Test
    void doesNotCallS3WhenThereIsNoMediaToDelete() {
        User user = User.builder()
                .id(userId)
                .cognitoSub(UUID.randomUUID())
                .username("someuser")
                .email("someuser@example.com")
                .displayName("Some User")
                .status(UserStatus.ACTIVE)
                .build();
        when(userRepository.findById(userId)).thenReturn(java.util.Optional.of(user));
        when(postRepository.findAllActiveByUserId(userId)).thenReturn(List.of());
        when(followGraphStore.listFollowers(userId)).thenReturn(List.of());
        when(cacheManager.getCache(any())).thenReturn(cache);

        service.deleteAccount(userId);

        verify(s3Client, never()).deleteObjects(any(DeleteObjectsRequest.class));
    }

    @Test
    void removesThisUsersPostDocsFromElasticsearchAndTheirOwnUserDoc() {
        User user = activeUser();
        when(userRepository.findById(userId)).thenReturn(java.util.Optional.of(user));
        when(postRepository.findAllActiveByUserId(userId)).thenReturn(List.of());
        when(followGraphStore.listFollowers(userId)).thenReturn(List.of());
        when(cacheManager.getCache(any())).thenReturn(cache);
        PostSearchDocument doc = PostSearchDocument.builder().id("post-1").userId(userId.toString()).build();
        when(postSearchRepository.findByUserIdOrderByCreatedAtDesc(userId.toString())).thenReturn(List.of(doc));

        service.deleteAccount(userId);

        verify(postSearchRepository).deleteAll(List.of(doc));
        verify(userSearchIndexer).delete(user);
    }

    @Test
    void unwindsTheFollowGraphAndLikesAndTheUsersOwnFeedPartition() {
        User user = activeUser();
        when(userRepository.findById(userId)).thenReturn(java.util.Optional.of(user));
        when(postRepository.findAllActiveByUserId(userId)).thenReturn(List.of());
        when(followGraphStore.listFollowers(userId)).thenReturn(List.of());
        when(cacheManager.getCache(any())).thenReturn(cache);

        service.deleteAccount(userId);

        verify(followGraphStore).unfollowAll(userId);
        verify(likeStore).unlikeAll(userId);
        verify(hideStore).unhideAll(userId);
        verify(feedStore).deleteAllForOwner(userId);
    }

    @Test
    void softDeletesPostsAndCommentsAndAnonymizesTheUserRowRatherThanHardDeleting() {
        User user = activeUser();
        when(userRepository.findById(userId)).thenReturn(java.util.Optional.of(user));
        Post post = Post.builder().id(UUID.randomUUID()).userId(userId).createdAt(Instant.now()).build();
        when(postRepository.findAllActiveByUserId(userId)).thenReturn(List.of(post));
        when(followGraphStore.listFollowers(userId)).thenReturn(List.of());
        when(cacheManager.getCache(any())).thenReturn(cache);

        service.deleteAccount(userId);

        assertThat(post.getDeletedAt()).isNotNull();
        verify(postRepository).saveAll(List.of(post));
        verify(commentRepository).softDeleteAllByUserId(eq(userId), any(Instant.class));

        verify(userRepository).save(user);
        UUID originalCognitoSub = user.getCognitoSub();
        assertThat(user.getUsername()).startsWith("deleted_").doesNotContain("someuser");
        assertThat(user.getEmail()).contains("deleted+").doesNotContain("someuser@example.com");
        assertThat(user.getBio()).isNull();
        assertThat(user.getAvatarUrl()).isNull();
        assertThat(user.getCoverImageUrl()).isNull();
        assertThat(user.getStatus()).isEqualTo(UserStatus.DEACTIVATED);
        assertThat(user.getFollowersCount()).isZero();
        assertThat(user.getFollowingCount()).isZero();
        assertThat(user.getPostsCount()).isZero();
        assertThat(user.getDeletedAt()).isNotNull();
        // cognitoSub is deliberately left untouched — see the class's own doc comment.
        assertThat(user.getCognitoSub()).isEqualTo(originalCognitoSub);
    }

    @Test
    void publishesDeletionStateForEveryCommentRemovedByAccountDeletion() {
        User user = activeUser();
        when(userRepository.findById(userId)).thenReturn(java.util.Optional.of(user));
        when(postRepository.findAllActiveByUserId(userId)).thenReturn(List.of());
        when(followGraphStore.listFollowers(userId)).thenReturn(List.of());
        when(cacheManager.getCache(any())).thenReturn(cache);
        Comment comment = Comment.builder()
                .id(UUID.randomUUID()).postId(UUID.randomUUID()).userId(userId).build();
        when(commentRepository.findAllByUserIdAndDeletedAtIsNull(userId)).thenReturn(List.of(comment));

        service.deleteAccount(userId);

        verify(warehouseEventPublisher).publishPostCommentDeleted(
                comment.getPostId(), comment.getId(), userId, userId, "account_deletion");
    }

    @Test
    void evictsAllThreeUserCachesUnderTheirOriginalPreScrubKeys() {
        User user = activeUser();
        String originalUsername = user.getUsername();
        UUID originalCognitoSub = user.getCognitoSub();
        when(userRepository.findById(userId)).thenReturn(java.util.Optional.of(user));
        when(postRepository.findAllActiveByUserId(userId)).thenReturn(List.of());
        when(followGraphStore.listFollowers(userId)).thenReturn(List.of());
        when(cacheManager.getCache(any())).thenReturn(cache);

        service.deleteAccount(userId);

        verify(cacheManager).getCache("usersById");
        verify(cacheManager).getCache("usersByUsername");
        verify(cacheManager).getCache("usersByCognitoSub");
        verify(cache).evict(userId.toString());
        verify(cache).evict(originalUsername.toLowerCase());
        verify(cache).evict(originalCognitoSub.toString());
    }

    @Test
    void doesNotBlowUpWhenACacheIsMissing() {
        User user = activeUser();
        when(userRepository.findById(userId)).thenReturn(java.util.Optional.of(user));
        when(postRepository.findAllActiveByUserId(userId)).thenReturn(List.of());
        when(followGraphStore.listFollowers(userId)).thenReturn(List.of());
        when(cacheManager.getCache(any())).thenReturn(null);

        service.deleteAccount(userId);

        verify(cache, never()).evict(any());
    }

    @Test
    void emitsAMetricOnSuccessfulDeletion() {
        User user = activeUser();
        when(userRepository.findById(userId)).thenReturn(java.util.Optional.of(user));
        when(postRepository.findAllActiveByUserId(userId)).thenReturn(List.of());
        when(followGraphStore.listFollowers(userId)).thenReturn(List.of());
        when(cacheManager.getCache(any())).thenReturn(cache);

        service.deleteAccount(userId);

        verify(emfMetrics).increment(eq("account_deletions_total"), any());
    }
}
