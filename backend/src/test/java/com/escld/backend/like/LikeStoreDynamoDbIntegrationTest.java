package com.escld.backend.like;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeDefinition;
import software.amazon.awssdk.services.dynamodb.model.BillingMode;
import software.amazon.awssdk.services.dynamodb.model.CreateTableRequest;
import software.amazon.awssdk.services.dynamodb.model.GlobalSecondaryIndex;
import software.amazon.awssdk.services.dynamodb.model.IndexStatus;
import software.amazon.awssdk.services.dynamodb.model.KeySchemaElement;
import software.amazon.awssdk.services.dynamodb.model.KeyType;
import software.amazon.awssdk.services.dynamodb.model.Projection;
import software.amazon.awssdk.services.dynamodb.model.ProjectionType;
import software.amazon.awssdk.services.dynamodb.model.ScalarAttributeType;
import software.amazon.awssdk.services.dynamodb.model.ScanRequest;

import com.escld.backend.warehouse.DynamoWarehouseOutbox;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Runs LikeStore against a real dynamodb-local container, not a mock —
 * closes the one gap explicitly left open when the byUserRecency GSI was
 * added (see infra/lib/likes-stack.ts): the schema and query-building logic
 * were verified at the CDK/unit level, but the GSI's actual recency-ordering
 * behavior had never been exercised against a real DynamoDB. The table here
 * is created with the exact same key schema as both infra/lib/likes-stack.ts
 * (production) and backend/bin/dynamodb/create_likes_table.sh (local dev) —
 * keep all three in sync if this schema ever changes.
 */
@Testcontainers
class LikeStoreDynamoDbIntegrationTest {

    private static final String TABLE_NAME = "likes-test";
    private static final String OUTBOX_TABLE_NAME = "domain-outbox-test";

    @Container
    static GenericContainer<?> dynamoDb = new GenericContainer<>(DockerImageName.parse("amazon/dynamodb-local:3.3.0"))
            .withExposedPorts(8000)
            .withCommand("-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb");

    static DynamoDbClient client;
    static LikeStore likeStore;

    @BeforeAll
    static void setUp() {
        String endpoint = "http://" + dynamoDb.getHost() + ":" + dynamoDb.getMappedPort(8000);
        client = DynamoDbClient.builder()
                .region(Region.EU_CENTRAL_1)
                .endpointOverride(URI.create(endpoint))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create("local", "local")))
                .build();

        client.createTable(CreateTableRequest.builder()
                .tableName(TABLE_NAME)
                .keySchema(
                        KeySchemaElement.builder().attributeName("pk").keyType(KeyType.HASH).build(),
                        KeySchemaElement.builder().attributeName("sk").keyType(KeyType.RANGE).build())
                .attributeDefinitions(
                        AttributeDefinition.builder().attributeName("pk").attributeType(ScalarAttributeType.S).build(),
                        AttributeDefinition.builder().attributeName("sk").attributeType(ScalarAttributeType.S).build(),
                        AttributeDefinition.builder()
                                .attributeName("createdAt")
                                .attributeType(ScalarAttributeType.S)
                                .build())
                .globalSecondaryIndexes(GlobalSecondaryIndex.builder()
                        .indexName("byUserRecency")
                        .keySchema(
                                KeySchemaElement.builder().attributeName("pk").keyType(KeyType.HASH).build(),
                                KeySchemaElement.builder()
                                        .attributeName("createdAt")
                                        .keyType(KeyType.RANGE)
                                        .build())
                        .projection(Projection.builder().projectionType(ProjectionType.KEYS_ONLY).build())
                        .build())
                .billingMode(BillingMode.PAY_PER_REQUEST)
                .build());

        waitForGsiActive();
        client.createTable(CreateTableRequest.builder()
                .tableName(OUTBOX_TABLE_NAME)
                .keySchema(KeySchemaElement.builder().attributeName("pk").keyType(KeyType.HASH).build())
                .attributeDefinitions(
                        AttributeDefinition.builder().attributeName("pk").attributeType(ScalarAttributeType.S).build(),
                        AttributeDefinition.builder().attributeName("pendingShard").attributeType(ScalarAttributeType.S).build(),
                        AttributeDefinition.builder().attributeName("availableAt").attributeType(ScalarAttributeType.S).build())
                .globalSecondaryIndexes(GlobalSecondaryIndex.builder()
                        .indexName(DynamoWarehouseOutbox.PENDING_INDEX)
                        .keySchema(
                                KeySchemaElement.builder().attributeName("pendingShard").keyType(KeyType.HASH).build(),
                                KeySchemaElement.builder().attributeName("availableAt").keyType(KeyType.RANGE).build())
                        .projection(Projection.builder().projectionType(ProjectionType.ALL).build())
                        .build())
                .billingMode(BillingMode.PAY_PER_REQUEST)
                .build());
        likeStore = new LikeStore(client, TABLE_NAME,
                new DynamoWarehouseOutbox(OUTBOX_TABLE_NAME, new ObjectMapper().findAndRegisterModules()));
    }

    @AfterAll
    static void tearDown() {
        client.close();
    }

    private static void waitForGsiActive() {
        for (int attempt = 0; attempt < 20; attempt++) {
            var table = client.describeTable(b -> b.tableName(TABLE_NAME)).table();
            boolean active = table.globalSecondaryIndexes().stream()
                    .allMatch(gsi -> gsi.indexStatus() == IndexStatus.ACTIVE);
            if (active) {
                return;
            }
            try {
                Thread.sleep(200);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(e);
            }
        }
        throw new IllegalStateException("byUserRecency GSI never became ACTIVE");
    }

    @Test
    void listsRecentlyLikedPostsNewestFirst() throws InterruptedException {
        UUID userId = UUID.randomUUID();
        UUID likedFirst = UUID.randomUUID();
        UUID likedSecond = UUID.randomUUID();

        likeStore.like(likedFirst, userId);
        Thread.sleep(5); // ensure the two createdAt timestamps genuinely differ
        likeStore.like(likedSecond, userId);

        List<UUID> recent = likeStore.listRecentLikedPostIds(userId, 10);

        assertThat(recent).containsExactly(likedSecond, likedFirst);
    }

    /**
     * The actual reason this GSI exists: proves listRecentLikedPostIds is
     * genuinely recency-ordered, not an accident of these particular post
     * ids also sorting that way as strings. Deliberately constructs post ids
     * whose lexicographic (sk = "LIKED#<postId>") order is the OPPOSITE of
     * their like order — the exact failure mode a plain Limit() on the base
     * table (whose sk isn't date-ordered) would have, which is why this
     * method exists instead of just adding a limit to listLikedPostIds.
     */
    @Test
    void isRecencyOrderedNotSortKeyOrdered() throws InterruptedException {
        UUID userId = UUID.randomUUID();
        UUID sortsFirstAsString = UUID.fromString("00000000-0000-0000-0000-000000000001");
        UUID sortsLastAsString = UUID.fromString("ffffffff-ffff-ffff-ffff-fffffffffff2");

        // Liked in an order that DISAGREES with string sort order: the
        // string-first id is liked (chronologically) first/oldest, the
        // string-last id is liked second/newest.
        likeStore.like(sortsFirstAsString, userId);
        Thread.sleep(5);
        likeStore.like(sortsLastAsString, userId);

        List<UUID> recent = likeStore.listRecentLikedPostIds(userId, 10);

        // Newest first (sortsLastAsString), despite it sorting last as a
        // plain string — a naive Limit()-on-sk approach would get this
        // backwards, or worse, return an arbitrary frozen subset entirely.
        assertThat(recent).containsExactly(sortsLastAsString, sortsFirstAsString);
    }

    @Test
    void limitsHowManyRecentLikesAreReturned() throws InterruptedException {
        UUID userId = UUID.randomUUID();
        for (int i = 0; i < 5; i++) {
            likeStore.like(UUID.randomUUID(), userId);
            Thread.sleep(2);
        }

        List<UUID> recent = likeStore.listRecentLikedPostIds(userId, 2);

        assertThat(recent).hasSize(2);
    }

    @Test
    void commitsTheLikeAndWarehouseEventInOneDynamoDbTransaction() {
        UUID userId = UUID.randomUUID();
        UUID postId = UUID.randomUUID();
        int before = client.scan(ScanRequest.builder().tableName(OUTBOX_TABLE_NAME).build()).count();

        assertThat(likeStore.like(postId, userId)).isTrue();
        assertThat(likeStore.like(postId, userId)).isFalse();

        var outboxItems = client.scan(ScanRequest.builder().tableName(OUTBOX_TABLE_NAME).build()).items();
        assertThat(outboxItems).hasSize(before + 1);
        assertThat(outboxItems.get(outboxItems.size() - 1).get("eventType").s()).isEqualTo("post.liked");
    }
}
