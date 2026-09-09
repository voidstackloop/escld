package com.escld.backend.hide;

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

class HideStoreTest {

    @Test
    void writesHideAndOutboxRecordInOneTransaction() {
        DynamoDbClient dynamo = mock(DynamoDbClient.class);
        when(dynamo.transactWriteItems(any(TransactWriteItemsRequest.class)))
                .thenReturn(TransactWriteItemsResponse.builder().build());
        var outbox = new DynamoWarehouseOutbox("domain_outbox", new ObjectMapper().findAndRegisterModules());
        var store = new HideStore(dynamo, "post_hides", outbox);

        store.hide(UUID.randomUUID(), UUID.randomUUID());

        var request = ArgumentCaptor.forClass(TransactWriteItemsRequest.class);
        verify(dynamo).transactWriteItems(request.capture());
        assertThat(request.getValue().transactItems()).hasSize(2);
        assertThat(request.getValue().transactItems().get(0).put().tableName()).isEqualTo("post_hides");
        assertThat(request.getValue().transactItems().get(0).put().conditionExpression())
                .contains("entityVersion < :newVersion");
        assertThat(request.getValue().transactItems().get(0).put().item().get("deleted").bool())
                .isFalse();
        assertThat(request.getValue().transactItems().get(1).put().tableName()).isEqualTo("domain_outbox");
        assertThat(request.getValue().transactItems().get(1).put().item().get("eventType").s())
                .isEqualTo("post.hidden");
    }

    @Test
    void writesUnhideAndOutboxRecordInOneTransaction() {
        DynamoDbClient dynamo = mock(DynamoDbClient.class);
        when(dynamo.transactWriteItems(any(TransactWriteItemsRequest.class)))
                .thenReturn(TransactWriteItemsResponse.builder().build());
        var outbox = new DynamoWarehouseOutbox("domain_outbox", new ObjectMapper().findAndRegisterModules());
        var store = new HideStore(dynamo, "post_hides", outbox);

        store.unhide(UUID.randomUUID(), UUID.randomUUID());

        var request = ArgumentCaptor.forClass(TransactWriteItemsRequest.class);
        verify(dynamo).transactWriteItems(request.capture());
        assertThat(request.getValue().transactItems()).hasSize(2);
        assertThat(request.getValue().transactItems().get(0).put().item().get("deleted").bool())
                .isTrue();
        assertThat(request.getValue().transactItems().get(0).put().conditionExpression())
                .contains("attribute_exists(pk)");
        assertThat(request.getValue().transactItems().get(1).put().item().get("eventType").s())
                .isEqualTo("post.unhidden");
    }
}
