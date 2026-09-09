package com.escld.backend.hide;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.util.List;
import java.util.Set;
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
import software.amazon.awssdk.services.dynamodb.model.KeySchemaElement;
import software.amazon.awssdk.services.dynamodb.model.KeyType;
import software.amazon.awssdk.services.dynamodb.model.ScalarAttributeType;

/**
 * Runs HideStore against a real dynamodb-local container, not a mock — same
 * reasoning as LikeStoreDynamoDbIntegrationTest. The table here is created
 * with the exact same key schema as both infra/lib/post-hides-stack.ts
 * (production) and backend/bin/dynamodb/create_post_hides_table.sh (local
 * dev) — keep all three in sync if this schema ever changes.
 */
@Testcontainers
class HideStoreDynamoDbIntegrationTest {

    private static final String TABLE_NAME = "post-hides-test";

    @Container
    static GenericContainer<?> dynamoDb = new GenericContainer<>(DockerImageName.parse("amazon/dynamodb-local:3.3.0"))
            .withExposedPorts(8000)
            .withCommand("-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb");

    static DynamoDbClient client;
    static HideStore hideStore;

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
                        AttributeDefinition.builder().attributeName("sk").attributeType(ScalarAttributeType.S).build())
                .billingMode(BillingMode.PAY_PER_REQUEST)
                .build());

        hideStore = new HideStore(client, TABLE_NAME);
    }

    @AfterAll
    static void tearDown() {
        client.close();
    }

    @Test
    void hidingAPostMakesItAppearInGetHiddenPostIdsForThatCandidateList() {
        UUID userId = UUID.randomUUID();
        UUID hiddenPost = UUID.randomUUID();
        UUID otherPost = UUID.randomUUID();

        hideStore.hide(userId, hiddenPost);

        Set<UUID> hidden = hideStore.getHiddenPostIds(userId, List.of(hiddenPost, otherPost));

        assertThat(hidden).containsExactly(hiddenPost);
    }

    @Test
    void hidingIsScopedToTheHidingUserOnly() {
        UUID userA = UUID.randomUUID();
        UUID userB = UUID.randomUUID();
        UUID postId = UUID.randomUUID();

        hideStore.hide(userA, postId);

        assertThat(hideStore.getHiddenPostIds(userB, List.of(postId))).isEmpty();
    }

    @Test
    void unhideRemovesAPreviouslyHiddenPost() {
        UUID userId = UUID.randomUUID();
        UUID postId = UUID.randomUUID();
        hideStore.hide(userId, postId);

        hideStore.unhide(userId, postId);

        assertThat(hideStore.getHiddenPostIds(userId, List.of(postId))).isEmpty();
    }

    @Test
    void unhideAllRemovesEveryHideThisUserMade() {
        UUID userId = UUID.randomUUID();
        UUID first = UUID.randomUUID();
        UUID second = UUID.randomUUID();
        hideStore.hide(userId, first);
        hideStore.hide(userId, second);

        hideStore.unhideAll(userId);

        assertThat(hideStore.listHiddenPostIds(userId)).isEmpty();
    }

    @Test
    void hidingTheSamePostTwiceIsIdempotent() {
        UUID userId = UUID.randomUUID();
        UUID postId = UUID.randomUUID();

        hideStore.hide(userId, postId);
        hideStore.hide(userId, postId);

        assertThat(hideStore.listHiddenPostIds(userId)).containsExactly(postId);
    }
}
