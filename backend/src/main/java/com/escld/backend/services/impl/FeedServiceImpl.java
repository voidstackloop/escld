package com.escld.backend.services.impl;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.data.domain.PageRequest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import com.escld.backend.cache.RedisBatchCache;
import com.escld.backend.analytics.ObservationTokenService;
import com.escld.backend.experiment.ExperimentAssignment;
import com.escld.backend.config.CacheConfig;
import com.escld.backend.dto.FeedPageResponse;
import com.escld.backend.dto.PostResponse;
import com.escld.backend.dto.RecommendationContext;
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
import com.escld.backend.services.FeedService;
import com.escld.backend.services.LikeService;
import com.escld.backend.trending.TrendingScoreClient;
import com.escld.backend.warehouse.WarehouseEventPublisher;

import software.amazon.cloudwatchlogs.emf.model.Unit;


/**
 * Assembles a user's feed: DynamoDB gives the candidate post ids in
 * chronological order (fan-out-on-write, see FeedStore); Postgres is the
 * source of truth for the post content itself (including engagement
 * counters); Elasticsearch supplies the sentence embeddings (computed by
 * feed-worker/) used both for semantic-affinity scoring and — since
 * PostSearchDocument also carries authorId/tags — to resolve the viewer's
 * recent-engagement history without a second N+1-prone Postgres round trip
 * (see computeEngagementHistory); TrendingScoreClient supplies analytics'
 * live, decaying engagement-momentum score (both trending:posts AND its
 * sibling trending:hashtags — see HASHTAG_TRENDING_WEIGHT); FollowGraphStore
 * supplies when the viewer followed each candidate's author;
 * SemanticDiscoveryClient supplies real semantic discovery beyond the follow
 * graph, gated to mode=for_you only (see getFeed). Final per-page order
 * blends seven signals: semantic affinity, all-time engagement, per-viewer
 * topic (hashtag) affinity, live trending momentum, and live *hashtag*
 * trending momentum are additive; per-viewer author affinity ("have I
 * actually engaged with THIS author before") and follow freshness ("did I
 * just follow them") are *multiplicative* boosts applied on top of that
 * blend, not two more additive terms — a flat addend can't express "this
 * should matter more when the rest of the signal is already strong," and an
 * additive scheme implicitly penalizes unfamiliar/long-followed authors by
 * omission, which a multiplier (×1 = no change) doesn't. One pass of
 * author-diversity re-ordering runs last so a single prolific poster still
 * can't dominate a page.
 *
 * Deletions aren't fanned out to DynamoDB — a deleted post's id can still
 * show up as a stale feed item, so it's simply skipped during hydration
 * rather than eagerly cleaned up. Same "best-effort denormalization"
 * trade-off already used for follower/following counts, and now also
 * accepted for the engagement-history lookup below (a deleted post can
 * still nudge affinity slightly until its ES doc is cleaned up elsewhere).
 *
 * The two bulk Postgres hydration reads (candidate posts, then their
 * authors) go through RedisBatchCache rather than a plain findAllById —
 * see CacheConfig's own javadoc for why @Cacheable can't do this — sharing
 * the "postsById"/"usersById" cache keyspace with PostServiceImpl#getById
 * and UserServiceImpl#getById respectively, so a single-post/user
 * @CacheEvict elsewhere also invalidates this class's batch-cached copy.
 */
@Service
public class FeedServiceImpl implements FeedService {

    /** How fast relevance decays with post age — larger window, gentler decay. */
    private static final double RECENCY_HALF_LIFE_HOURS = 48.0;

    /** How many of the user's own most recent posts define their "taste" vector. */
    private static final int AFFINITY_SAMPLE_SIZE = 20;

    /** How many of the viewer's most recent likes/comments (each, not
     * combined) feed the per-author and per-tag affinity signals below. */
    private static final int ENGAGEMENT_HISTORY_SAMPLE_SIZE = 30;

    /** Weights in the additive relevance blend (semantic / all-time
     * engagement / per-viewer tag affinity / live post-trending momentum /
     * live hashtag-trending momentum) — sum to 1.0. Semantic is cut only
     * modestly from its earlier 0.55 (not rebalanced away): it's the one
     * signal here with real validated behavior, while tag/author-affinity
     * are brand new and unvalidated, so the proven signal keeps the
     * plurality. Tag-affinity and both trending terms are all "additive,
     * absent = 0, never a penalty" for the same reason — most posts have no
     * current trending signal or tag overlap with the viewer's history, and
     * that should read as "no extra signal," not "downrank this." Adding
     * HASHTAG_TRENDING_WEIGHT took its share from TRENDING_WEIGHT (0.15 ->
     * 0.10), not from SEMANTIC_WEIGHT — the two trending terms are the same
     * underlying kind of signal (live analytics momentum), just against two
     * different keys in the same Redis store (see TrendingScoreClient), so
     * splitting one slot between them is more consistent than dipping into
     * the one proven signal for a new, related-but-distinct term. See
     * AUTHOR_AFFINITY_BOOST_WEIGHT below for why author affinity is
     * deliberately NOT a term here. */
    private static final double SEMANTIC_WEIGHT = 0.45;
    private static final double ENGAGEMENT_WEIGHT = 0.25;
    private static final double TAG_AFFINITY_WEIGHT = 0.15;
    private static final double TRENDING_WEIGHT = 0.10;

    /** How much a candidate's OWN tags currently trending platform-wide
     * (trending:hashtags, analytics/src/events.ts) boost it — distinct from
     * TAG_AFFINITY_WEIGHT (the viewer's personal history of engaging with a
     * tag): this one is a shared, real-time "this topic is hot right now"
     * signal, not personalized at all. Scored by the max across the post's
     * own tags (not sum) — one strongly-trending tag shouldn't need
     * reinforcement from also having two dead ones. */
    private static final double HASHTAG_TRENDING_WEIGHT = 0.05;

    /** How many real discovery candidates (beyond the follow graph) a
     * mode=for_you page tries to inject per fetch — see getFeed's
     * SemanticDiscoveryClient call. Multiplied by
     * app.feed.for-you.knn-overfetch-multiplier before actually querying
     * Elasticsearch, since eligibility filtering (hydrateEligible) removes
     * an unknown fraction of raw KNN hits (private authors chiefly —
     * PostSearchDocument doesn't carry visibility today, see
     * SemanticDiscoveryClient's own doc) — tune the multiplier from the
     * knn_candidates_requested/knn_candidates_surviving_eligibility metrics
     * this emits, don't guess a bigger fixed number here instead. */
    private static final int FOR_YOU_DISCOVERY_SLOTS = 10;

    /** Multiplicative boost (not part of the additive blend above) for posts
     * from an author the viewer has previously liked/commented on —
     * relevance *= 1 + this * authorAffinityScore, applied after the
     * additive blend and before recency decay. A stranger-authored post
     * gets ×1 (unchanged), never an implicit penalty. 0.5 means a maximally
     * familiar author's post gets up to 50% more relevance than the same
     * post would score from a stranger — deliberately capped below "can
     * override everything else" territory. */
    private static final double AUTHOR_AFFINITY_BOOST_WEIGHT = 0.5;

    /** First real A/B test wired through the experimentId/experimentVariant
     * fields WarehouseEventPublisher already carried but never populated —
     * see ExperimentAssignment. Deterministic per-viewer, no assignment
     * table: "treatment" gets the real AUTHOR_AFFINITY_BOOST_WEIGHT above,
     * "control" gets 0 (the boost fully off, not just weakened), so
     * feed.served warehouse rows let this be measured against real
     * engagement instead of taken on faith. */
    private static final String EXPERIMENT_AUTHOR_AFFINITY_BOOST_ID = "author_affinity_boost_v1";
    private static final List<String> EXPERIMENT_VARIANTS = List.of("control", "treatment");

    /** How many days a follow stays "fresh" enough to meaningfully boost that
     * author's posts — same decay shape as RECENCY_HALF_LIFE_HOURS, just on a
     * days-not-hours scale matching how long "I just followed someone, show
     * me more of them" plausibly stays true. */
    private static final double FOLLOW_FRESHNESS_HALF_LIFE_DAYS = 3.0;

    /** Multiplicative, compounding with AUTHOR_AFFINITY_BOOST_WEIGHT rather
     * than sharing a slot with it — this is a genuinely different signal
     * (when you followed them, not whether you've engaged with them since),
     * and unlike author-affinity, EVERY candidate has *some* value here
     * (every candidate's author is, definitionally, someone the viewer
     * follows — see FeedStore), so it acts as a broad decay curve across the
     * whole page rather than differentiating a handful of familiar posts.
     * Smaller than the author-affinity weight for exactly that reason: a
     * signal that touches every candidate should move the needle less per
     * candidate than one that only fires selectively. Zero for the viewer's
     * own posts (no follow edge to self). */
    private static final double FOLLOW_FRESHNESS_BOOST_WEIGHT = 0.3;

    /** Multiplicative, same "compounds independently" reasoning as the two
     * boosts above — a live stream's value is genuinely time-sensitive in a
     * way a static post's isn't; without this, a stream could easily be
     * buried by a stale-but-better-scoring post for the whole time it's
     * actually live, defeating the point of it being live at all. Sourced
     * directly from Post.getLiveStatus() (the Postgres entity already loaded
     * for every candidate), not the Elasticsearch document used for
     * semantic/tag scoring — that document is written once at announce time
     * and never re-indexed when a stream ends (see LiveStreamServiceImpl's
     * own doc), so it would keep boosting long-ended streams forever.
     * Weighted higher than the two affinity boosts: a live stream that isn't
     * surfaced while it's live has already lost the moment that made it
     * worth boosting, unlike an affinity signal which just needs to
     * eventually resurface. */
    private static final double LIVE_BOOST_WEIGHT = 1.0;

    /** Score multiplier applied when a candidate shares an author with the item ranked right before it. */
    private static final double AUTHOR_REPEAT_PENALTY = 0.5;

    // Ranking only reorders within a single fetched DynamoDB page, so a page
    // exactly `limit` long gives it nothing to work with — a post that's
    // slightly older than the newest few but far more engaging has nowhere
    // to move up from. Over-fetching a wider chronological window per page,
    // ranking within it, then truncating to `limit` fixes that. Ranked IDs
    // below the returned limit are retained in an immutable Redis snapshot;
    // the signed cursor advances through that order before following the
    // underlying DynamoDB source cursor, so no retained candidate is lost.
    private static final int CANDIDATE_WINDOW_MULTIPLIER = 3;
    private static final int MAX_CANDIDATES = 90;

    private final FeedStore feedStore;
    private final PostRepository postRepository;
    private final UserRepository userRepository;
    private final PostSearchRepository postSearchRepository;
    private final LikeService likeService;
    private final CommentRepository commentRepository;
    private final FollowGraphStore followGraphStore;
    private final HideStore hideStore;
    private final PostMapper postMapper;
    private final TrendingScoreClient trendingScoreClient;
    private final RedisBatchCache redisBatchCache;
    private final FeedSnapshotStore feedSnapshotStore;
    private final ObservationTokenService observationTokenService;
    private final WarehouseEventPublisher warehouseEventPublisher;
    private final SemanticDiscoveryClient semanticDiscoveryClient;
    private final EmfMetrics emfMetrics;
    private final int knnOverfetchMultiplier;

    @Autowired
    public FeedServiceImpl(FeedStore feedStore, PostRepository postRepository, UserRepository userRepository,
            PostSearchRepository postSearchRepository, LikeService likeService, CommentRepository commentRepository,
            FollowGraphStore followGraphStore, HideStore hideStore, PostMapper postMapper,
            TrendingScoreClient trendingScoreClient, RedisBatchCache redisBatchCache,
            FeedSnapshotStore feedSnapshotStore, ObservationTokenService observationTokenService,
            WarehouseEventPublisher warehouseEventPublisher, SemanticDiscoveryClient semanticDiscoveryClient,
            EmfMetrics emfMetrics,
            @Value("${app.feed.for-you.knn-overfetch-multiplier:3}") int knnOverfetchMultiplier) {
        this.feedStore = feedStore;
        this.postRepository = postRepository;
        this.userRepository = userRepository;
        this.postSearchRepository = postSearchRepository;
        this.likeService = likeService;
        this.commentRepository = commentRepository;
        this.followGraphStore = followGraphStore;
        this.hideStore = hideStore;
        this.postMapper = postMapper;
        this.trendingScoreClient = trendingScoreClient;
        this.redisBatchCache = redisBatchCache;
        this.feedSnapshotStore = feedSnapshotStore;
        this.observationTokenService = observationTokenService;
        this.warehouseEventPublisher = warehouseEventPublisher;
        this.semanticDiscoveryClient = semanticDiscoveryClient;
        this.emfMetrics = emfMetrics;
        this.knnOverfetchMultiplier = knnOverfetchMultiplier;
    }

    /** Compatibility constructor for focused tests that do not exercise request lineage. */
    public FeedServiceImpl(FeedStore feedStore, PostRepository postRepository, UserRepository userRepository,
            PostSearchRepository postSearchRepository, LikeService likeService, CommentRepository commentRepository,
            FollowGraphStore followGraphStore, HideStore hideStore, PostMapper postMapper,
            TrendingScoreClient trendingScoreClient, RedisBatchCache redisBatchCache,
            FeedSnapshotStore feedSnapshotStore, ObservationTokenService observationTokenService) {
        this(feedStore, postRepository, userRepository, postSearchRepository, likeService, commentRepository,
                followGraphStore, hideStore, postMapper, trendingScoreClient, redisBatchCache, feedSnapshotStore,
                observationTokenService, null, null, new EmfMetrics(), 3);
    }

    /** Compatibility constructor for focused unit tests of ranking in isolation. */
    public FeedServiceImpl(FeedStore feedStore, PostRepository postRepository, UserRepository userRepository,
            PostSearchRepository postSearchRepository, LikeService likeService, CommentRepository commentRepository,
            FollowGraphStore followGraphStore, HideStore hideStore, PostMapper postMapper,
            TrendingScoreClient trendingScoreClient, RedisBatchCache redisBatchCache,
            FeedSnapshotStore feedSnapshotStore) {
        this(feedStore, postRepository, userRepository, postSearchRepository, likeService, commentRepository,
                followGraphStore, hideStore, postMapper, trendingScoreClient, redisBatchCache, feedSnapshotStore, null);
    }

    public FeedServiceImpl(FeedStore feedStore, PostRepository postRepository, UserRepository userRepository,
            PostSearchRepository postSearchRepository, LikeService likeService, CommentRepository commentRepository,
            FollowGraphStore followGraphStore, HideStore hideStore, PostMapper postMapper,
            TrendingScoreClient trendingScoreClient, RedisBatchCache redisBatchCache) {
        this(feedStore, postRepository, userRepository, postSearchRepository, likeService, commentRepository,
                followGraphStore, hideStore, postMapper, trendingScoreClient, redisBatchCache, null, null);
    }

    /** The viewer's recent-engagement summary — how many times they've
     * engaged with each author/tag in their recent like+comment history.
     * Zero for an author/tag never seen means "no known affinity," not "seen
     * and unliked." A viewer explicitly hiding a post (see HideStore) is a
     * real negative signal, but it's applied as an exclusion filter on
     * candidates below, not folded into this affinity summary — hiding one
     * post from one author says nothing about the other signals here
     * (semantic/tag/engagement affinity), so treating it as a ranking input
     * rather than an outright removal would be both weaker than what the
     * viewer actually asked for and a more complex signal to tune correctly. */
    private record EngagementHistory(Map<UUID, Integer> authorCounts, Map<String, Integer> tagCounts) {
        private static final EngagementHistory EMPTY = new EngagementHistory(Map.of(), Map.of());
    }

    @Override
    public FeedPageResponse getFeed(UUID userId, int limit, String cursor) {
        return getFeed(userId, limit, cursor, null);
    }

    @Override
    public FeedPageResponse getFeed(UUID userId, int limit, String cursor, String mode) {
        String normalized = mode == null ? null : mode.toLowerCase();
        if (normalized != null && !normalized.equals("following") && !normalized.equals("for_you")) {
            throw new IllegalArgumentException("Invalid mode: " + mode);
        }
        // Computed once per request regardless of which branch below actually
        // ranks anything, so every feed.served row (including a snapshot
        // replay, which doesn't re-run rankFeed) carries consistent
        // attribution for the same viewer.
        String experimentVariant = ExperimentAssignment.assign(userId, EXPERIMENT_AUTHOR_AFFINITY_BOOST_ID, EXPERIMENT_VARIANTS);
        if (feedSnapshotStore != null && feedSnapshotStore.isSnapshotCursor(cursor)) {
            FeedSnapshotStore.Slice slice = feedSnapshotStore.resume(userId, cursor, limit, normalized);
            if (slice.postIds().isEmpty()) {
                if (slice.sourceCursor() == null) {
                    return renderPage(userId, List.of(), Map.of(), Set.of(), Map.of(), null, true, true,
                            EXPERIMENT_AUTHOR_AFFINITY_BOOST_ID, experimentVariant);
                }
                return getFeed(userId, limit, slice.sourceCursor(), normalized);
            }
            List<Post> retained = hydrateEligible(userId, slice.postIds(), resolveFollowedAtByAuthor(userId));
            Map<UUID, Double> retainedTrending = trendingScoreClient.getScores(
                    retained.stream().map(Post::getId).toList());
            // Snapshot-slice pages replay a frozen, already-ranked id list —
            // FeedSnapshotStore stores only post ids, not per-item source
            // attribution, so a discovery-sourced item on page 2+ of the same
            // snapshot currently reports as "following_inbox" here. A real,
            // small, documented limitation (see renderPage) — not silently
            // dropped — rather than a reason to change FeedSnapshotStore's
            // storage format for this pass.
            return renderPage(userId, retained, retainedTrending, Set.of(), Map.of(), slice.nextCursor(), true, true,
                    EXPERIMENT_AUTHOR_AFFINITY_BOOST_ID, experimentVariant);
        }

        int candidateLimit = Math.min(limit * CANDIDATE_WINDOW_MULTIPLIER, MAX_CANDIDATES);
        FeedPage page = feedStore.queryFeed(userId, candidateLimit, cursor);
        List<UUID> candidateIds = new ArrayList<>(page.items().stream().map(FeedItem::postId).toList());

        // Computed once here (not inside rankFeed) so it can also gate/seed
        // the for_you-only discovery merge below — same vector, one ES read,
        // used for both purposes.
        float[] affinity = computeAffinityVector(userId);

        // Real discovery beyond the follow graph — row 2 of
        // docs/DATA_ANALYSIS_AND_FEED_DESIGN.md's #6.1 retrieval table,
        // nothing more. Gated to for_you only: `following` is defined as
        // strictly "eligible followed authors and self" (see
        // SemanticDiscoveryClient's own doc), and mode=for_you currently
        // carries zero production traffic (no frontend caller sets it yet),
        // making this the one place a new, unproven candidate source can
        // ship with zero live blast radius.
        Set<UUID> discoveryPostIds = Set.of();
        if (semanticDiscoveryClient != null && "for_you".equals(normalized) && affinity != null) {
            int requested = knnOverfetchMultiplier * FOR_YOU_DISCOVERY_SLOTS;
            List<UUID> discovered = semanticDiscoveryClient.findSimilar(affinity, requested);
            if (!discovered.isEmpty()) {
                emfMetrics.recordValue("knn_candidates_requested", discovered.size(), Unit.COUNT, Map.of());
                Set<UUID> merged = new LinkedHashSet<>(candidateIds);
                merged.addAll(discovered);
                candidateIds = new ArrayList<>(merged);
                discoveryPostIds = new java.util.HashSet<>(discovered);
            }
        }

        // Batched through RedisBatchCache rather than a plain
        // postRepository.findAllById — a feed page's candidate ids change on
        // essentially every request, but any individual post is re-fetched
        // across many viewers' feeds, so this is exactly the "same items,
        // different combinations" shape @Cacheable can't handle (see
        // RedisBatchCache's own javadoc). The loader filters out
        // soft-deleted posts before returning them — required to preserve
        // PostServiceImpl#getById's invariant that a "postsById" cache hit is
        // never a deleted post, since both share the same cache name/keys.
        // Resolved once per request (not once inside hydrateEligible and
        // again inside rankFeed, which is what this used to do — two
        // DynamoDB Queries for the same user on every feed page) and passed
        // into both: eligibility gating needs only the key set, ranking's
        // follow-freshness boost needs the actual recency values.
        Map<UUID, Instant> followedAtByAuthor = resolveFollowedAtByAuthor(userId);

        List<Post> candidates = hydrateEligible(userId, candidateIds, followedAtByAuthor);

        if (!discoveryPostIds.isEmpty()) {
            Set<UUID> survivingIds = candidates.stream().map(Post::getId).collect(java.util.stream.Collectors.toSet());
            long survived = discoveryPostIds.stream().filter(survivingIds::contains).count();
            emfMetrics.recordValue("knn_candidates_surviving_eligibility", survived, Unit.COUNT, Map.of());
        }

        // Fetched once here (not inside rankFeed) so getFeed can also use it
        // below to flag which posts get the `trending` badge in the response —
        // one Redis round trip serves both ranking and display.
        Map<UUID, Double> trendingScores =
                trendingScoreClient.getScores(candidates.stream().map(Post::getId).toList());

        double authorAffinityBoostWeight = "treatment".equals(experimentVariant) ? AUTHOR_AFFINITY_BOOST_WEIGHT : 0.0;
        RankingResult ranking =
                rankFeed(userId, candidates, trendingScores, affinity, followedAtByAuthor, authorAffinityBoostWeight);
        List<Post> ranked = ranking.ranked();
        List<Post> top = ranked.size() > limit ? ranked.subList(0, limit) : ranked;
        String nextCursor = page.nextCursor();
        if (feedSnapshotStore != null) {
            nextCursor = feedSnapshotStore.create(userId, normalized, ranked.stream().map(Post::getId).toList(),
                    page.nextCursor(), top.size());
        }
        return renderPage(userId, top, trendingScores, discoveryPostIds, ranking.hashtagBoostByPostId(),
                nextCursor, cursor != null, false, EXPERIMENT_AUTHOR_AFFINITY_BOOST_ID, experimentVariant);
    }

    /** Best-effort: an unreachable follow store omits candidates needing it
     * rather than bypassing permission checks. */
    private Map<UUID, Instant> resolveFollowedAtByAuthor(UUID userId) {
        try {
            return followGraphStore.listFollowingWithRecency(userId);
        } catch (RuntimeException e) {
            return Map.of();
        }
    }

    private List<Post> hydrateEligible(UUID userId, List<UUID> candidateIds, Map<UUID, Instant> followedAtByAuthor) {
        Map<UUID, Post> postsById = redisBatchCache.getAll(
                "postsById",
                candidateIds,
                UUID::toString,
                CacheConfig.ENTITY_CACHE_TTL,
                missingIds -> {
                    Map<UUID, Post> loaded = new HashMap<>();
                    for (Post post : postRepository.findAllById(missingIds)) {
                        if (post.getDeletedAt() == null) {
                            // Same fix as PostServiceImpl#getById, needed
                            // independently here: this loader writes straight
                            // into the shared "postsById" cache bypassing
                            // getById entirely, so it hits the identical
                            // Hibernate-PersistentSet-vs-Jackson-default-typing
                            // problem (real EAGER data, but still wrapped in a
                            // Hibernate collection type that doesn't survive a
                            // Redis round trip) on its own.
                            post.setTags(new LinkedHashSet<>(post.getTags()));
                            loaded.put(post.getId(), post);
                        }
                    }
                    return loaded;
                });

        // Batched against just this page's candidate ids (see HideStore's own
        // doc for why this can't be a full per-user listing) — filtered out
        // entirely, not ranked lower, matching what "hide this" actually
        // means to the viewer who asked for it.
        Set<UUID> hiddenPostIds = hideStore.getHiddenPostIds(userId, candidateIds);

        // Private-account gating: public discovery never includes private
        // accounts; following includes a private author only with an accepted
        // current edge. Pending requests grant no access. One follow-list read
        // per page (not N+1 per candidate) — the caller-supplied recency map
        // already needed for ranking boosts, not a second DynamoDB Query.
        Set<UUID> followedIds = new java.util.HashSet<>(followedAtByAuthor.keySet());
        followedIds.add(userId);

        Map<UUID, com.escld.backend.entities.User> authorsById = redisBatchCache.getAll(
                "usersById",
                candidatesAuthorIds(postsById),
                UUID::toString,
                CacheConfig.ENTITY_CACHE_TTL,
                missingIds -> {
                    Map<UUID, com.escld.backend.entities.User> loaded = new HashMap<>();
                    for (com.escld.backend.entities.User u : userRepository.findAllById(missingIds)) {
                        loaded.put(u.getId(), u);
                    }
                    return loaded;
                });

        List<Post> candidates = new ArrayList<>();
        for (UUID postId : candidateIds) {
            Post post = postsById.get(postId);
            if (post == null || hiddenPostIds.contains(post.getId())) {
                continue;
            }
            // Media readiness: exclude still-processing or failed media.
            // Live eligibility comes from current post state; ended-live-only
            // announcements without playable replay are filtered by callers
            // with replay metadata (see LiveStreamServiceImpl).
            if (post.getMediaStatus() == com.escld.backend.post.PostMediaStatus.PROCESSING
                    || post.getMediaStatus() == com.escld.backend.post.PostMediaStatus.FAILED) {
                continue;
            }
            // Private authors: viewer must follow (or be self). Author-store
            // outage omits the candidate rather than exposing private content.
            com.escld.backend.entities.User author = authorsById.get(post.getUserId());
            if (author != null && author.isPrivateAccount() && !followedIds.contains(author.getId())) {
                continue;
            }
            // Moderation: no per-post removal index exists yet
            // (ModerationStore tracks reports/queue/actions, not a serving
            // filter). Removal-gated moderation joins land with the action
            // index; until then, reports do not suppress feed eligibility.
            candidates.add(post);
        }
        return candidates;
    }

    private List<UUID> candidatesAuthorIds(Map<UUID, Post> postsById) {
        return postsById.values().stream().map(Post::getUserId).distinct().toList();
    }

    private FeedPageResponse renderPage(UUID userId, List<Post> top, Map<UUID, Double> trendingScores,
            Set<UUID> discoveryPostIds, Map<UUID, Double> hashtagBoostByPostId,
            String nextCursor, boolean continuation, boolean servedFromSnapshot,
            String experimentId, String experimentVariant) {
        // Batch-fetch authors instead of one query per post (a feed's posts
        // usually come from many different authors, unlike a profile page's
        // posts which all share one) — this is the difference between one
        // query and N queries for an N-item feed page. Shares the "usersById"
        // cache/keyspace with UserServiceImpl#getById, same reasoning as the
        // postsById batch fetch above (no soft-delete invariant to preserve
        // here — UserServiceImpl#getById never filters by deletedAt).
        List<UUID> authorIds = top.stream().map(Post::getUserId).distinct().toList();
        Map<UUID, User> authorsById = redisBatchCache.getAll(
                "usersById",
                authorIds,
                UUID::toString,
                CacheConfig.USER_CACHE_TTL,
                missingIds -> {
                    Map<UUID, User> loaded = new HashMap<>();
                    userRepository.findAllById(missingIds).forEach(author -> loaded.put(author.getId(), author));
                    return loaded;
                });

        Set<UUID> likedPostIds = likeService.getLikedPostIds(userId, top.stream().map(Post::getId).toList());

        List<PostResponse> items = top.stream()
                .map(post -> postMapper.toResponse(
                        post,
                        authorsById.get(post.getUserId()),
                        likedPostIds.contains(post.getId()),
                        trendingScores.getOrDefault(post.getId(), 0.0) > TrendingScoreClient.TRENDING_DISPLAY_THRESHOLD))
                .toList();
        if (observationTokenService == null) return new FeedPageResponse(items, nextCursor);
        UUID requestId = UUID.randomUUID();
        Map<UUID, RecommendationContext> recommendations = new java.util.LinkedHashMap<>();
        List<WarehouseEventPublisher.ServedRecommendation> lineage = new ArrayList<>();
        for (int position = 0; position < items.size(); position++) {
            PostResponse item = items.get(position);
            // Real per-item provenance — see SemanticDiscoveryClient and
            // HASHTAG_TRENDING_WEIGHT for how each source is populated.
            // Snapshot-slice continuations (the servedFromSnapshot branch in
            // getFeed that replays a frozen ranked list) don't currently
            // retain per-item origin across pages, since FeedSnapshotStore
            // stores only ranked post ids — those pages fall back to
            // following_inbox/following even for an item that originally
            // came from discovery on an earlier page. A real, small,
            // documented limitation, not silently dropped.
            boolean fromDiscovery = discoveryPostIds.contains(item.id());
            String source = fromDiscovery ? "semantic_discovery" : "following_inbox";
            String reasonCode;
            if (fromDiscovery) {
                reasonCode = "semantic_discovery";
            } else if (hashtagBoostByPostId.getOrDefault(item.id(), 0.0) > 0.0) {
                reasonCode = "trending_hashtag";
            } else {
                reasonCode = "following";
            }
            recommendations.put(item.id(), new RecommendationContext(source, reasonCode,
                    observationTokenService.issue(userId, item.id(), requestId, position + 1)));
            lineage.add(new WarehouseEventPublisher.ServedRecommendation(
                    item.id(), position + 1, source, reasonCode));
        }
        if (warehouseEventPublisher != null) {
            warehouseEventPublisher.publishFeedServed(
                    userId, requestId, lineage, continuation, servedFromSnapshot, nextCursor != null,
                    experimentId, experimentVariant);
        }
        return new FeedPageResponse(items, nextCursor, requestId, recommendations);
    }

    /** Result of a rankFeed pass — the ranked list plus, per post, how much
     * the hashtag-trending term (see HASHTAG_TRENDING_WEIGHT) contributed.
     * The latter exists purely so renderPage can attribute a "trending
     * hashtag" reasonCode without recomputing the same lookup twice. */
    private record RankingResult(List<Post> ranked, Map<UUID, Double> hashtagBoostByPostId) {}

    private RankingResult rankFeed(UUID userId, List<Post> candidates, Map<UUID, Double> trendingScores,
            float[] affinity, Map<UUID, Instant> followedAtByAuthor, double authorAffinityBoostWeight) {
        // affinity is null for users with no post history yet (nothing to compare
        // against) — semanticScore then falls back to a neutral 0.5 per post below,
        // same as when a specific post has no embedding, so engagement + recency
        // still drive ranking for brand-new users instead of falling all the way
        // back to plain chronological order.
        if (candidates.isEmpty()) {
            return new RankingResult(candidates, Map.of());
        }

        List<String> ids = candidates.stream().map(p -> p.getId().toString()).toList();
        Map<String, PostSearchDocument> documents = new HashMap<>();
        postSearchRepository.findAllById(ids).forEach(doc -> documents.put(doc.getId(), doc));

        EngagementHistory history = computeEngagementHistory(userId);

        // Batched once per page for the union of every candidate's tags —
        // same "fetch once, not per-post" discipline as trendingScores/
        // history above. Lowercased defensively even though both write
        // paths (TagNormalizer, analytics/src/events.ts) already lowercase —
        // belt-and-suspenders against a future regression in that invariant.
        Set<String> candidateTags = new java.util.HashSet<>();
        for (PostSearchDocument doc : documents.values()) {
            if (doc.getTags() != null) {
                for (String tag : doc.getTags()) {
                    candidateTags.add(tag.toLowerCase());
                }
            }
        }
        Map<String, Double> hashtagScores = trendingScoreClient.getHashtagScores(new ArrayList<>(candidateTags));

        Instant now = Instant.now();
        Map<UUID, Double> scores = new HashMap<>();
        Map<UUID, Double> hashtagBoostByPostId = new HashMap<>();
        for (Post post : candidates) {
            PostSearchDocument doc = documents.get(post.getId().toString());
            double semanticScore = 0.5;
            if (affinity != null && doc != null && doc.getEmbedding() != null && !doc.getEmbedding().isEmpty()) {
                semanticScore = 0.5 + 0.5 * cosineSimilarity(affinity, toFloatArray(doc.getEmbedding()));
            }

            // Saturating (not linear) so a handful of viral outliers can't blow every
            // other signal out of the water — comments count double, since replying
            // takes more effort than a tap-to-like and is the stronger interest signal.
            double engagementScore = 1.0 - 1.0 / (1 + post.getLikeCount() + 2.0 * post.getCommentCount());

            // Same saturating shape as engagementScore, but fed by analytics'
            // live, decaying momentum score instead of Postgres's all-time
            // counters. Absent = never trended or already decayed out of the
            // sorted set -> 0, not a penalty (see TRENDING_WEIGHT's doc comment).
            Double rawTrendingScore = trendingScores.get(post.getId());
            double trendingBoost = rawTrendingScore != null ? 1.0 - 1.0 / (1 + rawTrendingScore) : 0.0;

            // How much overlap this post's tags have with tags the viewer has
            // recently engaged with elsewhere — summed across matching tags,
            // not just "any overlap," so engaging with the same topic
            // repeatedly compounds (saturating, same shape as everything else).
            // Also tracks the highest current trending:hashtags score across
            // the post's own tags for HASHTAG_TRENDING_WEIGHT below — a
            // platform-wide, non-personalized signal, distinct from this
            // per-viewer tag-affinity one.
            int tagOverlapCount = 0;
            double maxHashtagScore = 0.0;
            if (doc != null && doc.getTags() != null) {
                for (String tag : doc.getTags()) {
                    tagOverlapCount += history.tagCounts().getOrDefault(tag, 0);
                    Double hashtagScore = hashtagScores.get(tag.toLowerCase());
                    if (hashtagScore != null && hashtagScore > maxHashtagScore) {
                        maxHashtagScore = hashtagScore;
                    }
                }
            }
            double tagAffinityScore = 1.0 - 1.0 / (1 + tagOverlapCount);
            double hashtagTrendScore = maxHashtagScore > 0 ? 1.0 - 1.0 / (1 + maxHashtagScore) : 0.0;
            hashtagBoostByPostId.put(post.getId(), hashtagTrendScore);

            double relevance = SEMANTIC_WEIGHT * semanticScore
                    + ENGAGEMENT_WEIGHT * engagementScore
                    + TAG_AFFINITY_WEIGHT * tagAffinityScore
                    + TRENDING_WEIGHT * trendingBoost
                    + HASHTAG_TRENDING_WEIGHT * hashtagTrendScore;

            // Multiplicative, not folded into the additive blend above — see
            // AUTHOR_AFFINITY_BOOST_WEIGHT's own doc comment for why. The
            // weight itself is a caller-supplied parameter, not the constant
            // directly, so the author_affinity_boost_v1 experiment (see
            // getFeed) can zero it out for the control group.
            int authorEngagementCount = history.authorCounts().getOrDefault(post.getUserId(), 0);
            double authorAffinityScore = 1.0 - 1.0 / (1 + authorEngagementCount);
            relevance *= 1 + authorAffinityBoostWeight * authorAffinityScore;

            // A second, independent multiplicative factor — see
            // FOLLOW_FRESHNESS_BOOST_WEIGHT's own doc comment for why this
            // compounds with the author-affinity boost rather than sharing
            // its weight. Absent (the viewer's own posts have no follow edge
            // to themselves) -> 0 -> ×1, unchanged.
            Instant followedAt = followedAtByAuthor.get(post.getUserId());
            double followFreshnessScore = 0.0;
            if (followedAt != null) {
                double daysSinceFollowed = Duration.between(followedAt, now).toHours() / 24.0;
                followFreshnessScore = Math.pow(0.5, Math.max(0, daysSinceFollowed) / FOLLOW_FRESHNESS_HALF_LIFE_DAYS);
            }
            relevance *= 1 + FOLLOW_FRESHNESS_BOOST_WEIGHT * followFreshnessScore;

            // A third, independent multiplicative factor — see
            // LIVE_BOOST_WEIGHT's own doc comment for why this reads
            // liveStatus off the Postgres entity rather than the ES doc.
            if (post.getLiveStatus() == LiveStatus.LIVE) {
                relevance *= 1 + LIVE_BOOST_WEIGHT;
            }

            double ageHours = Duration.between(post.getCreatedAt(), now).toSeconds() / 3600.0;
            double recencyDecay = Math.pow(0.5, Math.max(0, ageHours) / RECENCY_HALF_LIFE_HOURS);
            scores.put(post.getId(), relevance * recencyDecay);
        }

        List<Post> byScore = candidates.stream()
                .sorted(Comparator.comparingDouble((Post p) -> scores.getOrDefault(p.getId(), 0.0)).reversed())
                .toList();

        return new RankingResult(applyAuthorDiversity(byScore, scores), hashtagBoostByPostId);
    }

    /**
     * Greedily re-orders a score-sorted list so consecutive same-author posts
     * are discouraged (not forbidden — a clearly-better post from the same
     * author than anything else left still wins) instead of a single prolific
     * poster filling several slots in a row.
     */
    private List<Post> applyAuthorDiversity(List<Post> byScore, Map<UUID, Double> scores) {
        List<Post> remaining = new ArrayList<>(byScore);
        List<Post> result = new ArrayList<>(remaining.size());
        UUID lastAuthorId = null;

        while (!remaining.isEmpty()) {
            Post best = null;
            double bestAdjustedScore = Double.NEGATIVE_INFINITY;
            for (Post candidate : remaining) {
                double adjusted = scores.getOrDefault(candidate.getId(), 0.0);
                if (candidate.getUserId().equals(lastAuthorId)) {
                    adjusted *= AUTHOR_REPEAT_PENALTY;
                }
                if (adjusted > bestAdjustedScore) {
                    bestAdjustedScore = adjusted;
                    best = candidate;
                }
            }
            result.add(best);
            remaining.remove(best);
            lastAuthorId = best.getUserId();
        }

        return result;
    }

    private float[] computeAffinityVector(UUID userId) {
        List<PostSearchDocument> recent = postSearchRepository.findByUserIdOrderByCreatedAtDesc(
                userId.toString(), org.springframework.data.domain.PageRequest.of(0, AFFINITY_SAMPLE_SIZE));
        List<float[]> vectors = recent.stream()
                .map(PostSearchDocument::getEmbedding)
                .filter(embedding -> embedding != null && !embedding.isEmpty())
                .map(this::toFloatArray)
                .toList();

        if (vectors.isEmpty()) {
            return null;
        }

        int dims = vectors.get(0).length;
        float[] sum = new float[dims];
        for (float[] vector : vectors) {
            for (int i = 0; i < dims; i++) {
                sum[i] += vector[i];
            }
        }
        for (int i = 0; i < dims; i++) {
            sum[i] /= vectors.size();
        }
        return sum;
    }

    /**
     * Tallies which authors and tags the viewer has recently engaged with
     * (a bounded sample of their most recent likes + comments, each capped
     * independently at ENGAGEMENT_HISTORY_SAMPLE_SIZE), by resolving those
     * post ids through Elasticsearch rather than Postgres. Post.tags is an
     * eager @ElementCollection with no batch-fetch size configured anywhere
     * in this app, so postRepository.findAllById(...) already pays one extra
     * query per row for the candidate fetch above — resolving this second,
     * unrelated set of post ids the same way would double that N+1 pattern.
     * PostSearchDocument already carries both authorId and tags (populated
     * by feed-worker at write time), so this reuses the same store
     * computeAffinityVector already reads the viewer's own posts from.
     */
    private EngagementHistory computeEngagementHistory(UUID userId) {
        List<UUID> recentLikedIds = likeService.getRecentLikedPostIds(userId, ENGAGEMENT_HISTORY_SAMPLE_SIZE);
        List<UUID> recentCommentedIds = commentRepository.findRecentPostIdsByUserId(
                userId, PageRequest.of(0, ENGAGEMENT_HISTORY_SAMPLE_SIZE));

        Set<String> engagedPostIds = new LinkedHashSet<>();
        recentLikedIds.forEach(id -> engagedPostIds.add(id.toString()));
        recentCommentedIds.forEach(id -> engagedPostIds.add(id.toString()));

        if (engagedPostIds.isEmpty()) {
            return EngagementHistory.EMPTY;
        }

        Map<UUID, Integer> authorCounts = new HashMap<>();
        Map<String, Integer> tagCounts = new HashMap<>();
        for (PostSearchDocument doc : postSearchRepository.findAllById(engagedPostIds)) {
            if (doc.getUserId() != null) {
                authorCounts.merge(UUID.fromString(doc.getUserId()), 1, Integer::sum);
            }
            if (doc.getTags() != null) {
                for (String tag : doc.getTags()) {
                    tagCounts.merge(tag, 1, Integer::sum);
                }
            }
        }
        return new EngagementHistory(authorCounts, tagCounts);
    }

    private float[] toFloatArray(List<Float> list) {
        float[] array = new float[list.size()];
        for (int i = 0; i < array.length; i++) {
            array[i] = list.get(i);
        }
        return array;
    }

    private double cosineSimilarity(float[] a, float[] b) {
        if (a.length != b.length) {
            return 0.0;
        }
        double dot = 0;
        double normA = 0;
        double normB = 0;
        for (int i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        if (normA == 0 || normB == 0) {
            return 0.0;
        }
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}
