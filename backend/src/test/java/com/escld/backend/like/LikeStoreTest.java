package com.escld.backend.like;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import com.escld.backend.warehouse.DynamoWarehouseOutbox;
import com.fasterxml.jackson.databind.ObjectMapper;

import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsRequest;
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsResponse;

class LikeStoreTest {

    @Test
    void writesUnlikeAndOutboxRecordInOneTransaction() {
        DynamoDbClient dynamo = mock(DynamoDbClient.class);
        when(dynamo.transactWriteItems(any(TransactWriteItemsRequest.class)))
                .thenReturn(TransactWriteItemsResponse.builder().build());
        var outbox = new DynamoWarehouseOutbox("domain_outbox", new ObjectMapper().findAndRegisterModules());
        var store = new LikeStore(dynamo, "likes", outbox);

        assertThat(store.unlike(UUID.randomUUID(), UUID.randomUUID())).isTrue();

        var request = ArgumentCaptor.forClass(TransactWriteItemsRequest.class);
        verify(dynamo).transactWriteItems(request.capture());
        assertThat(request.getValue().transactItems()).hasSize(3);
        // Unlike is now a versioned tombstone Put (not a hard Delete) so
        // like→unlike→relike ordering survives replay.
        assertThat(request.getValue().transactItems().get(0).put().item().get("deleted").bool())
                .isTrue();
        assertThat(request.getValue().transactItems().get(0).put().conditionExpression())
                .contains("attribute_exists(pk)");
        assertThat(request.getValue().transactItems().get(2).put().item().get("eventType").s())
                .isEqualTo("post.unliked");
    }

    @Test
    void likeConditionAllowsReusingATombstoneButNeverOverwritesAnAlreadyLiveEdge() {
        // Regression guard for a real bug: an earlier version of this
        // conditionExpression included "OR entityVersion < :newVersion" —
        // since entityVersion is always Instant.now().toEpochMilli() (see
        // WarehouseEvent), that clause was true on every single call
        // regardless of eventId, so a duplicate/retried like() silently
        // overwrote an already-live edge and returned true instead of the
        // idempotent false this class's own javadoc promises (caught by
        // LikeStoreDynamoDbIntegrationTest against a real table). The fixed
        // condition must allow a write when the item never existed OR was
        // tombstoned by a prior unlike (deleted=true) — and nothing else.
        DynamoDbClient dynamo = mock(DynamoDbClient.class);
        when(dynamo.transactWriteItems(any(TransactWriteItemsRequest.class)))
                .thenReturn(TransactWriteItemsResponse.builder().build());
        var outbox = new DynamoWarehouseOutbox("domain_outbox", new ObjectMapper().findAndRegisterModules());
        var store = new LikeStore(dynamo, "likes", outbox);

        assertThat(store.like(UUID.randomUUID(), UUID.randomUUID())).isTrue();

        var request = ArgumentCaptor.forClass(TransactWriteItemsRequest.class);
        verify(dynamo).transactWriteItems(request.capture());
        assertThat(request.getValue().transactItems()).hasSize(3);
        assertThat(request.getValue().transactItems().get(0).put().item().get("deleted").bool())
                .isFalse();
        String conditionExpression = request.getValue().transactItems().get(0).put().conditionExpression();
        assertThat(conditionExpression).contains("attribute_not_exists(pk)").contains("deleted = :true");
        assertThat(conditionExpression).doesNotContain("entityVersion");
    }
}
