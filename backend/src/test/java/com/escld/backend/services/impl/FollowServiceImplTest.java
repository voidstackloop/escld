package com.escld.backend.services.impl;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import com.escld.backend.cache.RedisBatchCache;
import com.escld.backend.dto.FollowState;
import com.escld.backend.entities.User;
import com.escld.backend.exceptions.SelfFollowException;
import com.escld.backend.feed.FeedStore;
import com.escld.backend.follow.FollowGraphStore;
import com.escld.backend.repo.PostRepository;
import com.escld.backend.repo.UserRepository;
import com.escld.backend.services.UserService;

@ExtendWith(MockitoExtension.class)
class FollowServiceImplTest {

    @Mock
    private FollowGraphStore graphStore;
    @Mock
    private UserRepository userRepository;
    @Mock
    private UserService userService;
    @Mock
    private PostRepository postRepository;
    @Mock
    private FeedStore feedStore;
    @Mock
    private RedisBatchCache redisBatchCache;

    @InjectMocks
    private FollowServiceImpl followService;

    @SuppressWarnings("unchecked")
    @BeforeEach
    void stubBatchCacheAsAlwaysMiss() {
        // Same pattern as FeedServiceImplTest: simulates an always-cache
        // -miss RedisBatchCache by delegating straight to whichever loader
        // FollowServiceImpl#resolve passed in, so existing
        // userRepository.findAllById stubs keep backing it unchanged.
        lenient().when(redisBatchCache.getAll(any(), any(), any(), any(), any())).thenAnswer(invocation -> {
            Collection<Object> ids = invocation.getArgument(1);
            Function<Collection<Object>, Map<Object, Object>> loader = invocation.getArgument(4);
            return loader.apply(ids);
        });
    }

    private final UUID followerId = UUID.randomUUID();
    private final UUID followeeId = UUID.randomUUID();

    @Test
    void followingYourselfIsRejected() {
        assertThatThrownBy(() -> followService.follow(followerId, followerId))
                .isInstanceOf(SelfFollowException.class);
        verifyNoGraphMutations();
    }

    @Test
    void followingSomeoneAlreadyFollowedIsAlreadyIdempotentNoOp() {
        when(graphStore.isFollowing(followerId, followeeId)).thenReturn(true);

        FollowState state = followService.follow(followerId, followeeId);

        assertThat(state).isEqualTo(FollowState.FOLLOWING);
        verify(userRepository, never()).findById(any());
        verify(userService, never()).incrementFollowingCount(any());
    }

    @Test
    void followingAPrivateAccountCreatesAPendingRequestInsteadOfFollowing() {
        when(graphStore.isFollowing(followerId, followeeId)).thenReturn(false);
        when(userRepository.findById(followeeId)).thenReturn(java.util.Optional.of(privateUser(followeeId)));
        when(graphStore.hasPendingRequest(followerId, followeeId)).thenReturn(false);

        FollowState state = followService.follow(followerId, followeeId);

        assertThat(state).isEqualTo(FollowState.PENDING);
        verify(graphStore).createRequest(followerId, followeeId);
        verify(graphStore, never()).follow(any(), any());
        verify(userService, never()).incrementFollowingCount(any());
    }

    @Test
    void followingAPrivateAccountWithAnExistingRequestDoesNotCreateADuplicateOne() {
        when(graphStore.isFollowing(followerId, followeeId)).thenReturn(false);
        when(userRepository.findById(followeeId)).thenReturn(java.util.Optional.of(privateUser(followeeId)));
        when(graphStore.hasPendingRequest(followerId, followeeId)).thenReturn(true);

        followService.follow(followerId, followeeId);

        verify(graphStore, never()).createRequest(any(), any());
    }

    @Test
    void followingAPublicAccountEstablishesTheFollowAndIncrementsBothCounts() {
        when(graphStore.isFollowing(followerId, followeeId)).thenReturn(false);
        when(userRepository.findById(followeeId)).thenReturn(java.util.Optional.of(publicUser(followeeId)));
        when(userRepository.findById(followerId)).thenReturn(java.util.Optional.of(publicUser(followerId)));
        when(postRepository.findFirstPageByUserId(any(), any())).thenReturn(List.of());
        when(graphStore.follow(followerId, followeeId)).thenReturn(true);

        FollowState state = followService.follow(followerId, followeeId);

        assertThat(state).isEqualTo(FollowState.FOLLOWING);
        verify(graphStore).follow(followerId, followeeId);
        // Clears any stale request left over from before the account went public —
        // see establishFollow's javadoc for why this is unconditional.
        verify(graphStore).deleteRequest(followerId, followeeId);
        verify(userService).incrementFollowingCount(followerId);
        verify(userService).incrementFollowersCount(followeeId);
    }

    @Test
    void unfollowingWithAPendingRequestJustCancelsTheRequest() {
        when(graphStore.hasPendingRequest(followerId, followeeId)).thenReturn(true);

        followService.unfollow(followerId, followeeId);

        verify(graphStore).deleteRequest(followerId, followeeId);
        verify(graphStore, never()).unfollow(any(), any());
        verify(userService, never()).decrementFollowingCount(any());
    }

    @Test
    void unfollowingSomeoneNotActuallyFollowedIsANoOp() {
        when(graphStore.hasPendingRequest(followerId, followeeId)).thenReturn(false);
        when(graphStore.isFollowing(followerId, followeeId)).thenReturn(false);

        followService.unfollow(followerId, followeeId);

        verify(graphStore, never()).unfollow(any(), any());
        verify(userService, never()).decrementFollowingCount(any());
    }

    @Test
    void unfollowingDecrementsBothCounts() {
        when(graphStore.hasPendingRequest(followerId, followeeId)).thenReturn(false);
        when(graphStore.isFollowing(followerId, followeeId)).thenReturn(true);
        when(graphStore.unfollow(followerId, followeeId)).thenReturn(true);

        followService.unfollow(followerId, followeeId);

        verify(graphStore).unfollow(followerId, followeeId);
        verify(userService).decrementFollowingCount(followerId);
        verify(userService).decrementFollowersCount(followeeId);
    }

    @Test
    void acceptingAStaleRequestWhereTheEdgeAlreadyExistsDoesNotDoubleCountFollowers() {
        // Regression test: acceptFollowRequest used to re-run establishFollow
        // unconditionally, double-counting followers/following whenever the
        // requester was already actually following (e.g. account went
        // private->public between the request and the accept).
        when(graphStore.hasPendingRequest(followeeId, followerId)).thenReturn(true);
        when(graphStore.isFollowing(followeeId, followerId)).thenReturn(true);

        followService.acceptFollowRequest(followerId, followeeId);

        verify(graphStore).deleteRequest(followeeId, followerId);
        verify(graphStore, never()).follow(any(), any());
        verify(userService, never()).incrementFollowingCount(any());
        verify(userService, never()).incrementFollowersCount(any());
    }

    @Test
    void ownerCanAlwaysViewTheirOwnFollowLists() {
        User self = privateUser(followerId);
        assertThat(followService.canViewFollowLists(followerId, self)).isTrue();
    }

    @Test
    void anyoneCanViewAPublicAccountsFollowLists() {
        User publicTarget = publicUser(followeeId);
        assertThat(followService.canViewFollowLists(followerId, publicTarget)).isTrue();
    }

    @Test
    void onlyFollowersCanViewAPrivateAccountsFollowLists() {
        User privateTarget = privateUser(followeeId);
        when(graphStore.isFollowing(followerId, followeeId)).thenReturn(false);

        assertThat(followService.canViewFollowLists(followerId, privateTarget)).isFalse();
    }

    private void verifyNoGraphMutations() {
        verify(graphStore, never()).follow(any(), any());
        verify(graphStore, never()).createRequest(any(), any());
    }

    private User privateUser(UUID id) {
        return User.builder().id(id).username("user-" + id).privateAccount(true).build();
    }

    private User publicUser(UUID id) {
        return User.builder().id(id).username("user-" + id).privateAccount(false).build();
    }
}
