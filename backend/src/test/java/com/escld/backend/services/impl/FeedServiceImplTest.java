package com.escld.backend.services.impl;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.verify;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import com.escld.backend.cache.RedisBatchCache;
import com.escld.backend.analytics.ObservationTokenService;
import com.escld.backend.warehouse.WarehouseEventPublisher;
import com.escld.backend.dto.FeedPageResponse;
import com.escld.backend.entities.Post;
import com.escld.backend.entities.User;
import com.escld.backend.feed.FeedItem;
import com.escld.backend.feed.FeedPage;
import com.escld.backend.feed.FeedStore;
import com.escld.backend.feed.FeedSnapshotStore;
import com.escld.backend.follow.FollowGraphStore;
import com.escld.backend.hide.HideStore;
import com.escld.backend.mappers.PostMapper;
import com.escld.backend.metrics.EmfMetrics;
import com.escld.backend.post.LiveStatus;
import com.escld.backend.repo.CommentRepository;
import com.escld.backend.repo.PostRepository;
import com.escld.backend.repo.UserRepository;
import com.escld.backend.search.PostSearchDocument;
import com.escld.backend.search.PostSearchRepository;
import com.escld.backend.search.SemanticDiscoveryClient;
import com.escld.backend.services.LikeService;
import com.escld.backend.trending.TrendingScoreClient;

import java.util.Map;

/**
 * Unit tests for the feed ranking algorithm (semantic affinity + engagement +
 * trending momentum + recency + author diversity) — see
 * FeedServiceImpl.rankFeed. Elasticsearch, DynamoDB, and the trending Redis
 * lookup are mocked out so these run without any real infrastructure; the
 * point is to pin down the ranking *behavior*, not exercise the stores.
 */
@ExtendWith(MockitoExtension.class)
class FeedServiceImplTest {

    @Mock
    private FeedStore feedStore;
    @Mock
    private PostRepository postRepository;
    @Mock
    private UserRepository userRepository;
    @Mock
    private PostSearchRepository postSearchRepository;
    @Mock
    private LikeService likeService;
    @Mock
    private CommentRepository commentRepository;
    @Mock
    private FollowGraphStore followGraphStore;
    @Mock
    private HideStore hideStore;
    @Mock
    private TrendingScoreClient trendingScoreClient;
    @Mock
    private RedisBatchCache redisBatchCache;
    @Mock
    private FeedSnapshotStore feedSnapshotStore;
    @Mock
    private ObservationTokenService observationTokenService;
    @Mock
    private WarehouseEventPublisher warehouseEventPublisher;
    @Mock
    private SemanticDiscoveryClient semanticDiscoveryClient;

    private FeedServiceImpl feedService;

    // Fixed, not random: FeedServiceImpl now deterministically hashes viewerId
    // into the author_affinity_boost_v1 experiment (see ExperimentAssignment).
    // A random UUID here would make
    // ranksACandidateFromAPreviouslyEngagedAuthorAboveAnOtherwiseIdenticalOne
    // flaky (~50% of runs would land in "control", where that boost is off).
    // This literal was checked to land in "treatment" for that experiment id.
    private final UUID viewerId = UUID.fromString("00000000-0000-0000-0000-000000000001");

    @BeforeEach
    void setUp() {
        feedService = new FeedServiceImpl(feedStore, postRepository, userRepository, postSearchRepository,
                likeService, commentRepository, followGraphStore, hideStore, new PostMapper(), trendingScoreClient,
                redisBatchCache, feedSnapshotStore, observationTokenService, warehouseEventPublisher,
                semanticDiscoveryClient, new EmfMetrics(), 3);

        // Simulates an always-cache-miss RedisBatchCache by delegating straight
        // to whichever loader FeedServiceImpl passed in — this is what lets
        // every existing postRepository.findAllById/userRepository.findAllById
        // stub below keep working unchanged: those mocks back the *loader*
        // functions now, not a direct call from FeedServiceImpl itself.
        lenient().when(redisBatchCache.getAll(any(), any(), any(), any(), any())).thenAnswer(invocation -> {
            Collection<Object> ids = invocation.getArgument(1);
            Function<Collection<Object>, Map<Object, Object>> loader = invocation.getArgument(4);
            return loader.apply(ids);
        });

        // No embeddings for any of these tests — isolates engagement/recency/diversity
        // behavior from the semantic-affinity component, which has its own concerns.
        // lenient: the empty-candidates fast path (rankFeed's early return) never
        // reaches these calls, and that's a legitimate test case, not a mistake.
        lenient().when(postSearchRepository.findAllById(any())).thenReturn(List.of());
        lenient().when(postSearchRepository.findByUserIdOrderByCreatedAtDesc(any())).thenReturn(List.of());
        lenient().when(postSearchRepository.findByUserIdOrderByCreatedAtDesc(any(), any())).thenReturn(List.of());

        lenient().when(likeService.getLikedPostIds(any(), any())).thenReturn(Set.of());

        // Nothing hidden by default — every test below that doesn't override
        // this exercises the "no negative signal present" path unchanged.
        lenient().when(hideStore.getHiddenPostIds(any(), any())).thenReturn(Set.of());

        // Empty engagement history by default (no known author/tag affinity) —
        // both new signals then contribute exactly 0/×1, a no-op on ordering
        // for every test below that doesn't override it. Same discipline
        // already applied when trending was added.
        lenient().when(likeService.getRecentLikedPostIds(any(), anyInt())).thenReturn(List.of());
        lenient().when(commentRepository.findRecentPostIdsByUserId(any(), any())).thenReturn(List.of());

        // No known follow dates by default -> followFreshnessScore is 0 (×1,
        // unchanged) for every candidate, a no-op on ordering.
        lenient().when(followGraphStore.listFollowingWithRecency(any())).thenReturn(Map.of());

        // Empty by default (nothing currently trending) — the additive design means
        // this contributes 0 uniformly to every candidate, so it's a no-op on
        // ordering for every test below that doesn't override it.
        lenient().when(trendingScoreClient.getScores(any())).thenReturn(Map.of());
        lenient().when(trendingScoreClient.getHashtagScores(any())).thenReturn(Map.of());

        // No discovery candidates by default — for_you-mode tests that care
        // override this explicitly; every other test (including plain
        // following-mode ones) must never see this called with a non-empty
        // result, and several below assert it's never called at all.
        lenient().when(semanticDiscoveryClient.findSimilar(any(), anyInt())).thenReturn(List.of());
    }

    @Test
    void ranksAHeavilyEngagedOlderPostAboveAFreshUnengagedOne() {
        Post fresh = post(1, 0, 0, Instant.now());
        Post engaged = post(2, 50, 20, Instant.now().minus(3, ChronoUnit.HOURS));

        FeedPageResponse response = getFeed(List.of(fresh, engaged));

        assertThat(response.items()).extracting(item -> item.id())
                .containsExactly(engaged.getId(), fresh.getId());
    }

    @Test
    void fallsBackToChronologicalWhenEngagementAndRecencyAreTied() {
        Instant now = Instant.now();
        Post first = post(1, 0, 0, now);
        Post second = post(2, 0, 0, now);

        FeedPageResponse response = getFeed(List.of(first, second));

        // Both score identically (same engagement, same age) — Post's natural stream
        // order (i.e. DynamoDB's chronological order) survives the stable sort.
        assertThat(response.items()).extracting(item -> item.id())
                .containsExactly(first.getId(), second.getId());
    }

    @Test
    void separatesConsecutivePostsFromTheSameAuthor() {
        UUID prolificAuthor = UUID.randomUUID();
        Instant now = Instant.now();

        // Same author, both with slightly higher engagement than the third post,
        // so without diversity they'd rank #1 and #2 back-to-back.
        Post authorPost1 = post(prolificAuthor, 10, 0, now);
        Post authorPost2 = post(prolificAuthor, 9, 0, now);
        Post otherPost = post(UUID.randomUUID(), 5, 0, now);

        FeedPageResponse response = getFeed(List.of(authorPost1, authorPost2, otherPost));

        List<UUID> order = response.items().stream().map(item -> item.id()).toList();
        assertThat(order).hasSize(3);
        // The prolific author's best post still leads (diversity discourages, doesn't
        // forbid), but their second post no longer sits directly after it.
        assertThat(order.get(0)).isEqualTo(authorPost1.getId());
        assertThat(order.get(1)).isEqualTo(otherPost.getId());
        assertThat(order.get(2)).isEqualTo(authorPost2.getId());
    }

    @Test
    void newViewerWithNoPostHistoryStillGetsEngagementRanking() {
        // computeAffinityVector reads the VIEWER's own posts — empty here, so affinity
        // is null. Ranking should still respond to engagement, not collapse to raw
        // chronological order (which would put fresh first here, defeating the point).
        Instant now = Instant.now();
        Post fresh = post(1, 0, 0, now);
        Post engaged = post(2, 20, 10, now);

        FeedPageResponse response = getFeed(List.of(fresh, engaged));

        assertThat(response.items()).extracting(item -> item.id())
                .containsExactly(engaged.getId(), fresh.getId());
    }

    @Test
    void aHiddenPostIsExcludedFromTheFeedEntirelyRatherThanJustRankedLower() {
        Instant now = Instant.now();
        Post hidden = post(1, 50, 20, now);
        Post visible = post(2, 0, 0, now);

        when(hideStore.getHiddenPostIds(eq(viewerId), any())).thenReturn(Set.of(hidden.getId()));

        FeedPageResponse response = getFeed(List.of(hidden, visible));

        // Not just outranked — hidden.getId() shouldn't appear at all, even
        // though its engagement counts would otherwise put it first.
        assertThat(response.items()).extracting(item -> item.id()).containsExactly(visible.getId());
    }

    @Test
    void aPostWithLiveTrendingMomentumOutranksAnOtherwiseIdenticalPostWithNone() {
        Instant now = Instant.now();
        Post untrending = post(1, 5, 0, now);
        Post trending = post(2, 5, 0, now);

        when(trendingScoreClient.getScores(any())).thenReturn(Map.of(trending.getId(), 10.0));

        FeedPageResponse response = getFeed(List.of(untrending, trending));

        assertThat(response.items()).extracting(item -> item.id())
                .containsExactly(trending.getId(), untrending.getId());
    }

    @Test
    void flagsAPostAsTrendingInTheResponseOnlyWhenItsScoreClearsTheDisplayThreshold() {
        Instant now = Instant.now();
        Post genuinelyTrending = post(1, 0, 0, now);
        Post justCreatedNoRealEngagementYet = post(2, 0, 0, now);
        Post neverTrended = post(3, 0, 0, now);

        // 1.0 is exactly the baseline every post gets from its own post_created
        // event (see TRENDING_DISPLAY_THRESHOLD's doc comment) — must NOT be
        // enough on its own to earn the badge; only a score genuinely above
        // that (a like/comment happened) should.
        when(trendingScoreClient.getScores(any())).thenReturn(
                Map.of(genuinelyTrending.getId(), 4.0, justCreatedNoRealEngagementYet.getId(), 1.0));

        FeedPageResponse response =
                getFeed(List.of(genuinelyTrending, justCreatedNoRealEngagementYet, neverTrended));

        Map<UUID, Boolean> trendingByPostId = response.items().stream()
                .collect(java.util.stream.Collectors.toMap(item -> item.id(), item -> item.trending()));
        assertThat(trendingByPostId.get(genuinelyTrending.getId())).isTrue();
        assertThat(trendingByPostId.get(justCreatedNoRealEngagementYet.getId())).isFalse();
        assertThat(trendingByPostId.get(neverTrended.getId())).isFalse();
    }

    @Test
    void aLivePostOutranksAnOtherwiseIdenticalNonLivePost() {
        Instant now = Instant.now();
        Post live = livePost(1, 5, 0, now, LiveStatus.LIVE);
        Post notLive = livePost(2, 5, 0, now, null);

        FeedPageResponse response = getFeed(List.of(notLive, live));

        assertThat(response.items()).extracting(item -> item.id())
                .containsExactly(live.getId(), notLive.getId());
    }

    @Test
    void anEndedLiveStreamGetsNoLiveBoostUnlikeAStillLiveOne() {
        // Guards against sourcing the boost from the Elasticsearch document
        // (written once at announce time, never re-indexed on end) instead
        // of the Postgres entity's own liveStatus, which endLiveStream does
        // flip synchronously — see LIVE_BOOST_WEIGHT's own doc comment.
        Instant now = Instant.now();
        Post stillLive = livePost(1, 5, 0, now, LiveStatus.LIVE);
        Post ended = livePost(2, 5, 0, now, LiveStatus.ENDED);

        FeedPageResponse response = getFeed(List.of(ended, stillLive));

        assertThat(response.items()).extracting(item -> item.id())
                .containsExactly(stillLive.getId(), ended.getId());
    }

    @Test
    void ranksACandidateFromAPreviouslyEngagedAuthorAboveAnOtherwiseIdenticalOne() {
        Instant now = Instant.now();
        UUID familiarAuthor = UUID.randomUUID();
        Post fromFamiliarAuthor = post(familiarAuthor, 5, 0, now);
        Post fromStranger = post(UUID.randomUUID(), 5, 0, now);

        UUID engagedPostId = UUID.randomUUID();
        when(likeService.getRecentLikedPostIds(eq(viewerId), anyInt())).thenReturn(List.of(engagedPostId));
        PostSearchDocument engagedDoc =
                PostSearchDocument.builder().id(engagedPostId.toString()).userId(familiarAuthor.toString()).build();
        stubSearchDocsById(Map.of(engagedPostId.toString(), engagedDoc));

        FeedPageResponse response = getFeed(List.of(fromStranger, fromFamiliarAuthor));

        assertThat(response.items()).extracting(item -> item.id())
                .containsExactly(fromFamiliarAuthor.getId(), fromStranger.getId());
    }

    @Test
    void ranksACandidateWithOverlappingTagsAboveAnOtherwiseIdenticalOne() {
        Instant now = Instant.now();
        Post withOverlappingTag = post(1, 5, 0, now);
        Post withoutOverlappingTag = post(2, 5, 0, now);

        UUID engagedPostId = UUID.randomUUID();
        when(commentRepository.findRecentPostIdsByUserId(eq(viewerId), any())).thenReturn(List.of(engagedPostId));
        PostSearchDocument engagedDoc = PostSearchDocument.builder()
                .id(engagedPostId.toString())
                .userId(UUID.randomUUID().toString())
                .tags(Set.of("kittens"))
                .build();
        PostSearchDocument overlapping = PostSearchDocument.builder()
                .id(withOverlappingTag.getId().toString())
                .userId(withOverlappingTag.getUserId().toString())
                .tags(Set.of("kittens"))
                .build();
        PostSearchDocument nonOverlapping = PostSearchDocument.builder()
                .id(withoutOverlappingTag.getId().toString())
                .userId(withoutOverlappingTag.getUserId().toString())
                .tags(Set.of("puppies"))
                .build();
        stubSearchDocsById(Map.of(
                engagedPostId.toString(), engagedDoc,
                withOverlappingTag.getId().toString(), overlapping,
                withoutOverlappingTag.getId().toString(), nonOverlapping));

        FeedPageResponse response = getFeed(List.of(withOverlappingTag, withoutOverlappingTag));

        assertThat(response.items()).extracting(item -> item.id())
                .containsExactly(withOverlappingTag.getId(), withoutOverlappingTag.getId());
    }

    @Test
    void aPostWithATrendingHashtagOutranksAnOtherwiseIdenticalPostWithout() {
        Instant now = Instant.now();
        Post withTrendingTag = post(1, 5, 0, now);
        Post withoutTrendingTag = post(2, 5, 0, now);

        PostSearchDocument trendingDoc = PostSearchDocument.builder()
                .id(withTrendingTag.getId().toString())
                .userId(withTrendingTag.getUserId().toString())
                .tags(Set.of("travel"))
                .build();
        PostSearchDocument otherDoc = PostSearchDocument.builder()
                .id(withoutTrendingTag.getId().toString())
                .userId(withoutTrendingTag.getUserId().toString())
                .tags(Set.of("food"))
                .build();
        stubSearchDocsById(Map.of(
                withTrendingTag.getId().toString(), trendingDoc,
                withoutTrendingTag.getId().toString(), otherDoc));
        when(trendingScoreClient.getHashtagScores(any())).thenReturn(Map.of("travel", 8.0));

        FeedPageResponse response = getFeed(List.of(withTrendingTag, withoutTrendingTag));

        assertThat(response.items()).extracting(item -> item.id())
                .containsExactly(withTrendingTag.getId(), withoutTrendingTag.getId());
        assertThat(response.recommendations().get(withTrendingTag.getId()).reasonCode())
                .isEqualTo("trending_hashtag");
    }

    @Test
    void absentHashtagTrendingDataDegradesToCurrentBehaviorUnchanged() {
        // Regression guard for the additive design: a hashtag score present
        // for a tag NEITHER candidate has must contribute exactly 0 to both,
        // preserving the existing tie-break (stable chronological) order.
        Instant now = Instant.now();
        Post first = post(1, 0, 0, now);
        Post second = post(2, 0, 0, now);
        when(trendingScoreClient.getHashtagScores(any())).thenReturn(Map.of("unrelated-tag", 99.0));

        FeedPageResponse response = getFeed(List.of(first, second));

        assertThat(response.items()).extracting(item -> item.id())
                .containsExactly(first.getId(), second.getId());
    }

    @Test
    void newViewerWithNoEngagementHistoryStillRanksSanelyOnAuthorAndTagAffinity() {
        // Distinct from newViewerWithNoPostHistoryStillGetsEngagementRanking above —
        // that one is about the semantic-affinity signal (viewer's own posts).
        // This is about the author/tag-affinity signals (viewer's likes/comments),
        // which default to empty via setUp()'s lenient stubs. Should not throw,
        // and engagement + recency should still drive ranking.
        Instant now = Instant.now();
        Post fresh = post(1, 0, 0, now);
        Post engaged = post(2, 20, 10, now);

        FeedPageResponse response = getFeed(List.of(fresh, engaged));

        assertThat(response.items()).extracting(item -> item.id())
                .containsExactly(engaged.getId(), fresh.getId());
    }

    @Test
    void authorAffinityBoostScalesWithBaseRelevanceRatherThanAddingAFlatAmount() {
        // Same author-affinity treatment (viewer engaged with exactly 1 post by
        // familiarAuthor -> authorAffinityScore=0.5 -> a 1.25x multiplier)
        // applied to a high-base-relevance post and a low-base-relevance post
        // from that SAME author, bracketed by a stranger-authored post whose
        // unboosted base sits strictly between the two familiar posts'
        // boosted scores (verified by hand against the real weights: base
        // relevance = 0.45*0.5(neutral semantic) + 0.25*engagementScore;
        // highBase(like=99)=0.4725*1.25=0.590625, stranger(like=9)=0.45x1=0.45,
        // lowBase(like=1)=0.35*1.25=0.4375). If the boost were a flat additive
        // amount instead, the same amount would either push both familiar
        // posts past the stranger or neither — a multiplicative boost instead
        // lets the high-base post leapfrog while the low-base post, despite
        // identical author-affinity treatment, cannot.
        Instant now = Instant.now();
        UUID familiarAuthor = UUID.randomUUID();
        Post highBaseFamiliar = post(familiarAuthor, 99, 0, now);
        Post lowBaseFamiliar = post(familiarAuthor, 1, 0, now);
        Post stranger = post(UUID.randomUUID(), 9, 0, now);

        UUID engagedPostId = UUID.randomUUID();
        when(likeService.getRecentLikedPostIds(eq(viewerId), anyInt())).thenReturn(List.of(engagedPostId));
        PostSearchDocument engagedDoc =
                PostSearchDocument.builder().id(engagedPostId.toString()).userId(familiarAuthor.toString()).build();
        stubSearchDocsById(Map.of(engagedPostId.toString(), engagedDoc));

        FeedPageResponse response = getFeed(List.of(highBaseFamiliar, lowBaseFamiliar, stranger));

        assertThat(response.items()).extracting(item -> item.id())
                .containsExactly(highBaseFamiliar.getId(), stranger.getId(), lowBaseFamiliar.getId());
    }

    @Test
    void fetchesOnlyTheBoundedRecentEngagementHistoryNotTheFullLikeOrCommentHistory() {
        Instant now = Instant.now();
        getFeed(List.of(post(1, 0, 0, now)));

        // 30 -- see ENGAGEMENT_HISTORY_SAMPLE_SIZE. Bounded on purpose: this is a
        // per-request personalization signal, not the complete history GDPR
        // deletion needs (see LikeStore#listLikedPostIds vs #listRecentLikedPostIds).
        org.mockito.Mockito.verify(likeService).getRecentLikedPostIds(viewerId, 30);
        org.mockito.Mockito.verify(commentRepository)
                .findRecentPostIdsByUserId(eq(viewerId), argThat(p -> p.getPageSize() == 30));
    }

    @Test
    void ranksACandidateFromARecentlyFollowedAuthorAboveAnOtherwiseIdenticalOneFromALongAgoFollow() {
        Instant now = Instant.now();
        UUID recentlyFollowedAuthor = UUID.randomUUID();
        UUID longAgoFollowedAuthor = UUID.randomUUID();
        Post fromRecentFollow = post(recentlyFollowedAuthor, 5, 0, now);
        Post fromOldFollow = post(longAgoFollowedAuthor, 5, 0, now);

        when(followGraphStore.listFollowingWithRecency(viewerId)).thenReturn(Map.of(
                recentlyFollowedAuthor, now.minus(1, ChronoUnit.HOURS),
                longAgoFollowedAuthor, now.minus(365, ChronoUnit.DAYS)));

        FeedPageResponse response = getFeed(List.of(fromOldFollow, fromRecentFollow));

        assertThat(response.items()).extracting(item -> item.id())
                .containsExactly(fromRecentFollow.getId(), fromOldFollow.getId());
    }

    @Test
    void aViewersOwnPostsGetNoFollowFreshnessBoostSinceThereIsNoFollowEdgeToSelf() {
        // Regression guard: viewerId itself must never accidentally show up as
        // a key in followGraphStore.listFollowingWithRecency's result (you
        // can't follow yourself — see SelfFollowException) — if it did, this
        // would silently give the viewer's own posts an unearned boost.
        Instant now = Instant.now();
        UUID otherAuthor = UUID.randomUUID();
        Post ownPost = post(viewerId, 5, 0, now);
        Post otherPost = post(otherAuthor, 5, 0, now);

        when(followGraphStore.listFollowingWithRecency(viewerId))
                .thenReturn(Map.of(otherAuthor, now.minus(1, ChronoUnit.HOURS)));

        FeedPageResponse response = getFeed(List.of(ownPost, otherPost));

        // otherPost gets the freshness boost (just followed); ownPost gets none.
        assertThat(response.items()).extracting(item -> item.id())
                .containsExactly(otherPost.getId(), ownPost.getId());
    }

    @Test
    void emptyCandidatePageReturnsEmptyResponseWithoutError() {
        when(feedStore.queryFeed(eq(viewerId), anyInt(), any())).thenReturn(new FeedPage(List.of(), null));

        FeedPageResponse response = feedService.getFeed(viewerId, 20, null);

        assertThat(response.items()).isEmpty();
        assertThat(response.nextCursor()).isNull();
    }

    @Test
    void widensTheDynamoCandidateWindowBeyondTheRequestedLimit() {
        when(feedStore.queryFeed(eq(viewerId), anyInt(), any())).thenReturn(new FeedPage(List.of(), null));

        feedService.getFeed(viewerId, 20, null);

        // 3x the requested limit (capped at 90) — see CANDIDATE_WINDOW_MULTIPLIER.
        org.mockito.Mockito.verify(feedStore).queryFeed(viewerId, 60, null);
    }

    @Test
    void truncatesRankedResultsToTheRequestedLimit() {
        Instant now = Instant.now();
        List<Post> posts = List.of(
                post(1, 5, 0, now), post(2, 4, 0, now), post(3, 3, 0, now));

        FeedPageResponse response = getFeed(posts, 2);

        assertThat(response.items()).hasSize(2);
    }

    @Test
    void retainsRankedResultsBelowTheFirstPageInASnapshot() {
        Instant now = Instant.now();
        List<Post> posts = List.of(
                post(1, 5, 0, now), post(2, 4, 0, now), post(3, 3, 0, now));
        when(feedSnapshotStore.create(eq(viewerId), eq((String) null), any(), any(), eq(2))).thenReturn("fs1.cursor");

        FeedPageResponse response = getFeed(posts, 2);

        assertThat(response.nextCursor()).isEqualTo("fs1.cursor");
        verify(feedSnapshotStore).create(eq(viewerId), eq((String) null), argThat(ids -> ids.size() == 3), any(), eq(2));
    }

    @Test
    void issuesOneViewerBoundObservationTokenPerServedPosition() {        Post first = post(1, 2, 0, Instant.now());
        Post second = post(2, 1, 0, Instant.now());
        when(observationTokenService.issue(eq(viewerId), eq(first.getId()), any(), eq(1))).thenReturn("token-1");
        when(observationTokenService.issue(eq(viewerId), eq(second.getId()), any(), eq(2))).thenReturn("token-2");

        FeedPageResponse response = getFeed(List.of(first, second));

        assertThat(response.requestId()).isNotNull();
        assertThat(response.recommendations().get(first.getId()).observationToken()).isEqualTo("token-1");
        assertThat(response.recommendations().get(second.getId()).observationToken()).isEqualTo("token-2");
        verify(warehouseEventPublisher).publishFeedServed(
                eq(viewerId), eq(response.requestId()), argThat(items ->
                        items.size() == 2
                                && items.get(0).postId().equals(first.getId())
                                && items.get(0).position() == 1
                                && items.get(0).source().equals("following_inbox")
                                && items.get(1).postId().equals(second.getId())
                                && items.get(1).position() == 2),
                eq(false), eq(false), eq(false), any(), any());
    }

    @Test
    void excludesPrivateAuthorsTheViewerDoesNotFollow() {
        UUID strangerPrivate = UUID.randomUUID();
        UUID followedPrivate = UUID.randomUUID();
        Post strangerPost = post(strangerPrivate, 50, 20, Instant.now());
        Post followedPost = post(followedPrivate, 1, 0, Instant.now());
        List<Post> candidates = List.of(strangerPost, followedPost);
        List<FeedItem> items = candidates.stream()
                .map(p -> new FeedItem(p.getId(), p.getUserId(), p.getCreatedAt()))
                .toList();
        when(feedStore.queryFeed(eq(viewerId), anyInt(), any())).thenReturn(new FeedPage(items, null));
        when(postRepository.findAllById(any())).thenReturn(candidates);
        when(followGraphStore.listFollowingWithRecency(eq(viewerId)))
                .thenReturn(Map.of(followedPrivate, Instant.now()));
        when(userRepository.findAllById(any())).thenReturn(List.of(
                privateUser(strangerPrivate), privateUser(followedPrivate)));

        FeedPageResponse response = feedService.getFeed(viewerId, 20, null);

        assertThat(response.items()).extracting(item -> item.id())
                .containsExactly(followedPost.getId());
    }

    @Test
    void excludesProcessingAndFailedMedia() {
        Post processing = post(1, 50, 20, Instant.now());
        processing.setMediaStatus(com.escld.backend.post.PostMediaStatus.PROCESSING);
        Post failed = post(2, 50, 20, Instant.now());
        failed.setMediaStatus(com.escld.backend.post.PostMediaStatus.FAILED);
        Post ready = post(3, 1, 0, Instant.now());
        ready.setMediaStatus(com.escld.backend.post.PostMediaStatus.READY);

        FeedPageResponse response = getFeed(List.of(processing, failed, ready));

        assertThat(response.items()).extracting(item -> item.id())
                .containsExactly(ready.getId());
    }

    @Test
    void explicitModesCreateModeBoundSnapshots() {
        Post only = post(1, 1, 0, Instant.now());
        when(feedSnapshotStore.create(eq(viewerId), eq("for_you"), any(), any(), eq(1)))
                .thenReturn("fs2.cursor");

        List<FeedItem> items = List.of(new FeedItem(only.getId(), only.getUserId(), only.getCreatedAt()));
        when(feedStore.queryFeed(eq(viewerId), anyInt(), any())).thenReturn(new FeedPage(items, null));
        when(postRepository.findAllById(any())).thenReturn(List.of(only));
        when(userRepository.findAllById(any())).thenReturn(List.of(userWithId(only.getUserId())));

        FeedPageResponse response = feedService.getFeed(viewerId, 20, null, "for_you");

        assertThat(response.nextCursor()).isEqualTo("fs2.cursor");
        verify(feedSnapshotStore).create(eq(viewerId), eq("for_you"), any(), any(), eq(1));
    }

    @Test
    void modeForYouMergesAndRanksRealDiscoveryCandidatesFromSemanticDiscoveryClient() {
        Instant now = Instant.now();
        Post fromFollowGraph = post(1, 0, 0, now);
        Post discovered = post(2, 0, 0, now);

        List<FeedItem> items = List.of(
                new FeedItem(fromFollowGraph.getId(), fromFollowGraph.getUserId(), fromFollowGraph.getCreatedAt()));
        when(feedStore.queryFeed(eq(viewerId), anyInt(), any())).thenReturn(new FeedPage(items, null));
        when(postRepository.findAllById(any())).thenReturn(List.of(fromFollowGraph, discovered));
        when(userRepository.findAllById(any())).thenReturn(
                List.of(userWithId(fromFollowGraph.getUserId()), userWithId(discovered.getUserId())));
        // affinity must be non-null for the discovery merge to fire at all —
        // computeAffinityVector reads the viewer's own posts from ES.
        when(postSearchRepository.findByUserIdOrderByCreatedAtDesc(eq(viewerId.toString()), any())).thenReturn(List.of(
                PostSearchDocument.builder().id(UUID.randomUUID().toString())
                        .embedding(List.of(1.0f, 0.0f)).build()));
        when(semanticDiscoveryClient.findSimilar(any(), anyInt())).thenReturn(List.of(discovered.getId()));

        FeedPageResponse response = feedService.getFeed(viewerId, 20, null, "for_you");

        assertThat(response.items()).extracting(item -> item.id())
                .containsExactlyInAnyOrder(fromFollowGraph.getId(), discovered.getId());
        assertThat(response.recommendations().get(discovered.getId()).source()).isEqualTo("semantic_discovery");
        assertThat(response.recommendations().get(discovered.getId()).reasonCode()).isEqualTo("semantic_discovery");
        assertThat(response.recommendations().get(fromFollowGraph.getId()).source()).isEqualTo("following_inbox");
    }

    @Test
    void explicitFollowingModeNeverCallsSemanticDiscoveryClient() {
        Post only = post(1, 0, 0, Instant.now());
        List<FeedItem> items = List.of(new FeedItem(only.getId(), only.getUserId(), only.getCreatedAt()));
        when(feedStore.queryFeed(eq(viewerId), anyInt(), any())).thenReturn(new FeedPage(items, null));
        when(postRepository.findAllById(any())).thenReturn(List.of(only));
        when(userRepository.findAllById(any())).thenReturn(List.of(userWithId(only.getUserId())));

        feedService.getFeed(viewerId, 20, null, "following");

        org.mockito.Mockito.verifyNoInteractions(semanticDiscoveryClient);
    }

    @Test
    void omittedModeNeverCallsSemanticDiscoveryClient() {
        getFeed(List.of(post(1, 0, 0, Instant.now())));

        org.mockito.Mockito.verifyNoInteractions(semanticDiscoveryClient);
    }

    // --- helpers ---
    /** Answers postSearchRepository.findAllById(...) by looking up whichever
     * ids were actually requested in `docsById` — robust to the method being
     * called twice per rankFeed invocation (once for the candidate ids,
     * once inside computeEngagementHistory for the engaged-post ids), with
     * different id sets and collection types (List vs Set) each time, unlike
     * a single eq(...)-matched stub. */
    private void stubSearchDocsById(Map<String, PostSearchDocument> docsById) {
        when(postSearchRepository.findAllById(any())).thenAnswer(invocation -> {
            Iterable<String> requestedIds = invocation.getArgument(0);
            Set<String> requested = new HashSet<>();
            requestedIds.forEach(requested::add);
            return docsById.values().stream().filter(doc -> requested.contains(doc.getId())).toList();
        });
    }

    private FeedPageResponse getFeed(List<Post> candidates) {
        return getFeed(candidates, 20);
    }

    private FeedPageResponse getFeed(List<Post> candidates, int limit) {
        List<FeedItem> items = candidates.stream()
                .map(p -> new FeedItem(p.getId(), p.getUserId(), p.getCreatedAt()))
                .toList();
        when(feedStore.queryFeed(eq(viewerId), anyInt(), any())).thenReturn(new FeedPage(items, null));
        when(postRepository.findAllById(any())).thenReturn(candidates);

        List<User> authors = candidates.stream()
                .map(Post::getUserId)
                .distinct()
                .map(this::userWithId)
                .toList();
        when(userRepository.findAllById(any())).thenReturn(authors);

        return feedService.getFeed(viewerId, limit, null);
    }

    private Post post(int discriminator, int likeCount, int commentCount, Instant createdAt) {
        return post(UUID.randomUUID(), likeCount, commentCount, createdAt);
    }

    private Post post(UUID authorId, int likeCount, int commentCount, Instant createdAt) {
        return Post.builder()
                .id(UUID.randomUUID())
                .userId(authorId)
                .text("post")
                .tags(Set.of())
                .likeCount(likeCount)
                .commentCount(commentCount)
                .createdAt(createdAt)
                .build();
    }

    private Post livePost(int discriminator, int likeCount, int commentCount, Instant createdAt, LiveStatus liveStatus) {
        return Post.builder()
                .id(UUID.randomUUID())
                .userId(UUID.randomUUID())
                .text("post")
                .tags(Set.of())
                .likeCount(likeCount)
                .commentCount(commentCount)
                .createdAt(createdAt)
                .liveStatus(liveStatus)
                .build();
    }

    private User userWithId(UUID id) {
        return User.builder()
                .id(id)
                .username("user-" + id)
                .displayName("User " + id)
                .build();
    }

    private User privateUser(UUID id) {
        return User.builder()
                .id(id)
                .username("user-" + id)
                .displayName("User " + id)
                .privateAccount(true)
                .build();
    }
}
