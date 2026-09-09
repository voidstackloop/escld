package com.escld.backend.services.impl;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.cache.CacheManager;
import org.springframework.cache.concurrent.ConcurrentMapCacheManager;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import com.escld.backend.entities.Comment;
import com.escld.backend.entities.Post;
import com.escld.backend.entities.User;
import com.escld.backend.feed.FeedStore;
import com.escld.backend.follow.FollowGraphStore;
import com.escld.backend.hide.HideStore;
import com.escld.backend.like.LikeStore;
import com.escld.backend.metrics.EmfMetrics;
import com.escld.backend.repo.CommentRepository;
import com.escld.backend.repo.PostRepository;
import com.escld.backend.repo.UserRepository;
import com.escld.backend.search.PostSearchRepository;
import com.escld.backend.search.UserSearchIndexer;
import com.escld.backend.user.UserStatus;

import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeDefinition;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.BillingMode;
import software.amazon.awssdk.services.dynamodb.model.CreateTableRequest;
import software.amazon.awssdk.services.dynamodb.model.GlobalSecondaryIndex;
import software.amazon.awssdk.services.dynamodb.model.KeySchemaElement;
import software.amazon.awssdk.services.dynamodb.model.KeyType;
import software.amazon.awssdk.services.dynamodb.model.QueryRequest;
import software.amazon.awssdk.services.dynamodb.model.ScalarAttributeType;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectsResponse;

/**
 * Exercises AccountDeletionService against real Postgres and real DynamoDB
 * (dynamodb-local) — the cross-store correctness claim the plan's own
 * verification section named as needing a real run, not a code read. Elasticsearch
 * and S3 stay mocked (see AccountDeletionServiceImplTest for their own
 * orchestration coverage) — this test's job is the two stores where the
 * actual data-shape risk lives: Postgres anonymization/soft-delete under
 * real constraints, and the DynamoDB adjacency-list unwind (follow graph,
 * likes, feed fan-out) against real tables with the same schema as
 * production (see infra/lib/social-graph-stack.ts, likes-stack.ts,
 * feed-stack.ts).
 */
@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Testcontainers
class AccountDeletionServiceRealStoresIntegrationTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:17");

    @Container
    static GenericContainer<?> dynamoDb = new GenericContainer<>(DockerImageName.parse("amazon/dynamodb-local:3.3.0"))
            .withExposedPorts(8000)
            .withCommand("-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb");

    private static final String FOLLOWS_TABLE = "follows-test";
    private static final String LIKES_TABLE = "likes-test";
    private static final String FEED_TABLE = "feed-test";

    static DynamoDbClient dynamoClient;

    @BeforeAll
    static void migrateSchemaAndCreateTables() {
        Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .load()
                .migrate();

        String endpoint = "http://" + dynamoDb.getHost() + ":" + dynamoDb.getMappedPort(8000);
        dynamoClient = DynamoDbClient.builder()
                .region(Region.EU_CENTRAL_1)
                .endpointOverride(URI.create(endpoint))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create("local", "local")))
                .build();

        createPkSkTable(FOLLOWS_TABLE, false);
        createPkSkTable(LIKES_TABLE, true);
        createPkSkTable(FEED_TABLE, false);
    }

    private static void createPkSkTable(String tableName, boolean withRecencyGsi) {
        var builder = CreateTableRequest.builder()
                .tableName(tableName)
                .keySchema(
                        KeySchemaElement.builder().attributeName("pk").keyType(KeyType.HASH).build(),
                        KeySchemaElement.builder().attributeName("sk").keyType(KeyType.RANGE).build())
                .billingMode(BillingMode.PAY_PER_REQUEST);

        if (withRecencyGsi) {
            builder.attributeDefinitions(
                    AttributeDefinition.builder().attributeName("pk").attributeType(ScalarAttributeType.S).build(),
                    AttributeDefinition.builder().attributeName("sk").attributeType(ScalarAttributeType.S).build(),
                    AttributeDefinition.builder()
                            .attributeName("createdAt")
                            .attributeType(ScalarAttributeType.S)
                            .build());
            builder.globalSecondaryIndexes(GlobalSecondaryIndex.builder()
                    .indexName("byUserRecency")
                    .keySchema(
                            KeySchemaElement.builder().attributeName("pk").keyType(KeyType.HASH).build(),
                            KeySchemaElement.builder().attributeName("createdAt").keyType(KeyType.RANGE).build())
                    .projection(p -> p.projectionType(software.amazon.awssdk.services.dynamodb.model.ProjectionType.KEYS_ONLY))
                    .build());
        } else {
            builder.attributeDefinitions(
                    AttributeDefinition.builder().attributeName("pk").attributeType(ScalarAttributeType.S).build(),
                    AttributeDefinition.builder().attributeName("sk").attributeType(ScalarAttributeType.S).build());
        }

        dynamoClient.createTable(builder.build());
    }

    @AfterAll
    static void closeDynamoClient() {
        dynamoClient.close();
    }

    @Autowired
    private UserRepository userRepository;
    @Autowired
    private PostRepository postRepository;
    @Autowired
    private CommentRepository commentRepository;

    private FollowGraphStore followGraphStore;
    private LikeStore likeStore;
    private FeedStore feedStore;
    private AccountDeletionServiceImpl accountDeletionService;
    private S3Client s3Client;

    @BeforeEach
    void setUp() {
        followGraphStore = new FollowGraphStore(dynamoClient, FOLLOWS_TABLE);
        likeStore = new LikeStore(dynamoClient, LIKES_TABLE);
        feedStore = new FeedStore(dynamoClient, FEED_TABLE);
        s3Client = mock(S3Client.class);
        when(s3Client.deleteObjects(any(software.amazon.awssdk.services.s3.model.DeleteObjectsRequest.class)))
                .thenReturn(DeleteObjectsResponse.builder().build());

        accountDeletionService = new AccountDeletionServiceImpl(
                userRepository,
                postRepository,
                commentRepository,
                followGraphStore,
                likeStore,
                // Mocked, not a real table — this test's own scope (per its
                // class doc) is proving the highest-risk real-store paths
                // (follows/likes/feed fan-out cleanup), not every store this
                // service touches; HideStoreImplTest-equivalent coverage for
                // hides specifically isn't this test's job.
                mock(HideStore.class),
                feedStore,
                mock(PostSearchRepository.class),
                mock(UserSearchIndexer.class),
                s3Client,
                emptyCacheManager(),
                mock(EmfMetrics.class),
                "test-media-bucket",
                "cdn.test.invalid");
    }

    private CacheManager emptyCacheManager() {
        return new ConcurrentMapCacheManager("usersById", "usersByUsername", "usersByCognitoSub");
    }

    @Test
    void deletesAccountAcrossRealPostgresAndRealDynamoDb() {
        User deletedUser = userRepository.save(freshUser("deleteme"));
        User follower = userRepository.save(freshUser("follower"));
        User followee = userRepository.save(freshUser("followee"));

        // saveAndFlush, not save: createdAt is DB-generated (see Post's
        // @Generated(event = INSERT)) and stays null on the returned entity
        // until a flush actually round-trips to Postgres — backfillRecentPosts
        // below needs the real value.
        Post post = postRepository.saveAndFlush(Post.builder()
                .userId(deletedUser.getId())
                .text("post by the user being deleted")
                .tags(java.util.Set.of())
                .build());
        Comment comment = commentRepository.save(Comment.builder()
                .postId(post.getId())
                .userId(deletedUser.getId())
                .text("a comment by the user being deleted")
                .build());

        // Real social graph: follower -> deletedUser, deletedUser -> followee.
        followGraphStore.follow(follower.getId(), deletedUser.getId());
        followGraphStore.follow(deletedUser.getId(), followee.getId());

        // Real likes: deletedUser liked some post.
        UUID likedPostId = UUID.randomUUID();
        likeStore.like(likedPostId, deletedUser.getId());

        // Simulate feed-worker's fan-out: deletedUser's post shows up in
        // follower's feed, and deletedUser's own feed has an item too.
        feedStore.backfillRecentPosts(follower.getId(), List.of(post));
        feedStore.backfillRecentPosts(deletedUser.getId(), List.of(post));

        accountDeletionService.deleteAccount(deletedUser.getId());

        // --- Postgres: anonymized, not hard-deleted ---
        User reloaded = userRepository.findById(deletedUser.getId()).orElseThrow();
        assertThat(reloaded.getUsername()).startsWith("deleted_").doesNotContain("deleteme");
        assertThat(reloaded.getEmail()).doesNotContain("deleteme");
        assertThat(reloaded.getStatus()).isEqualTo(UserStatus.DEACTIVATED);
        assertThat(reloaded.getDeletedAt()).isNotNull();

        Post reloadedPost = postRepository.findById(post.getId()).orElseThrow();
        assertThat(reloadedPost.getDeletedAt()).isNotNull();

        Comment reloadedComment = commentRepository.findById(comment.getId()).orElseThrow();
        assertThat(reloadedComment.getDeletedAt()).isNotNull();

        // --- DynamoDB: follow graph genuinely unwound both directions ---
        assertThat(followGraphStore.isFollowing(follower.getId(), deletedUser.getId())).isFalse();
        assertThat(followGraphStore.listFollowers(deletedUser.getId())).isEmpty();
        assertThat(followGraphStore.isFollowing(deletedUser.getId(), followee.getId())).isFalse();
        assertThat(followGraphStore.listFollowers(followee.getId())).isEmpty();

        // --- DynamoDB: likes genuinely gone ---
        assertThat(likeStore.listLikedPostIds(deletedUser.getId())).isEmpty();

        // --- DynamoDB: feed fan-out genuinely removed from the follower's
        // feed, and deletedUser's own feed partition wiped ---
        assertThat(queryFeedPartition(follower.getId())).isEmpty();
        assertThat(queryFeedPartition(deletedUser.getId())).isEmpty();
    }

    private List<Map<String, AttributeValue>> queryFeedPartition(UUID ownerId) {
        return dynamoClient.query(QueryRequest.builder()
                .tableName(FEED_TABLE)
                .keyConditionExpression("pk = :pk")
                .expressionAttributeValues(Map.of(":pk", AttributeValue.fromS("USER#" + ownerId)))
                .build())
                .items();
    }

    private User freshUser(String usernamePrefix) {
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        return User.builder()
                .cognitoSub(UUID.randomUUID())
                .username(usernamePrefix + "_" + suffix)
                .email(usernamePrefix + "_" + suffix + "@example.com")
                .displayName(usernamePrefix)
                .build();
    }
}
