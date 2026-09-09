package com.escld.backend.warehouse;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.ObjectMapper;

class DynamoWarehouseOutboxTest {

    @Test
    void buildsAStableVersionedPendingEventForATransaction() throws Exception {
        var outbox = new DynamoWarehouseOutbox("domain-outbox-test", new ObjectMapper().findAndRegisterModules());
        UUID postId = UUID.randomUUID();
        UUID userId = UUID.randomUUID();

        WarehouseEvent event = outbox.postLiked(postId, userId);
        var put = outbox.put(event).put();
        var item = put.item();

        assertThat(put.tableName()).isEqualTo("domain-outbox-test");
        assertThat(put.conditionExpression()).isEqualTo("attribute_not_exists(pk)");
        assertThat(item.get("pk").s()).isEqualTo("EVENT#" + event.eventId());
        assertThat(item.get("eventType").s()).isEqualTo("post.liked");
        assertThat(item.get("eventVersion").s()).isEqualTo("2");
        assertThat(item.get("pendingShard").s()).startsWith("PENDING#");
        assertThat(item.get("partitionKey").s()).isEqualTo(postId.toString());
        assertThat(new ObjectMapper().readTree(item.get("payload").s()).get("userId").asText())
                .isEqualTo(userId.toString());
    }

    @Test
    void buildsHideAndUnhideEventsWithTheSameEntityIdentity() {
        var outbox = new DynamoWarehouseOutbox("domain-outbox-test", new ObjectMapper().findAndRegisterModules());
        UUID userId = UUID.randomUUID();
        UUID postId = UUID.randomUUID();

        WarehouseEvent hidden = outbox.postHidden(userId, postId);
        WarehouseEvent unhidden = outbox.postUnhidden(userId, postId);

        assertThat(hidden.eventType()).isEqualTo("post.hidden");
        assertThat(unhidden.eventType()).isEqualTo("post.unhidden");
        assertThat(hidden.partitionKey()).isEqualTo(postId.toString());
        assertThat(unhidden.partitionKey()).isEqualTo(postId.toString());
        assertThat(hidden.entityId()).isEqualTo(unhidden.entityId()).isEqualTo(userId + ":" + postId);
    }

    @Test
    void buildsUnlikeWithTheSameEntityIdentityAsLike() {
        var outbox = new DynamoWarehouseOutbox("domain-outbox-test", new ObjectMapper().findAndRegisterModules());
        UUID userId = UUID.randomUUID();
        UUID postId = UUID.randomUUID();

        WarehouseEvent liked = outbox.postLiked(postId, userId);
        WarehouseEvent unliked = outbox.postUnliked(postId, userId);

        assertThat(unliked.eventType()).isEqualTo("post.unliked");
        assertThat(unliked.partitionKey()).isEqualTo(liked.partitionKey());
        assertThat(unliked.entityId()).isEqualTo(liked.entityId());
    }

    @Test
    void assignsMonotonicEntityVersionsForReorderedTransitions() throws Exception {
        var outbox = new DynamoWarehouseOutbox("domain-outbox-test", new ObjectMapper().findAndRegisterModules());
        UUID userId = UUID.randomUUID();
        UUID postId = UUID.randomUUID();

        WarehouseEvent liked = outbox.postLiked(postId, userId);
        Thread.sleep(2);
        WarehouseEvent unliked = outbox.postUnliked(postId, userId);
        Thread.sleep(2);
        WarehouseEvent reliked = outbox.postLiked(postId, userId);

        assertThat(liked.entityVersion()).isNotNull();
        assertThat(unliked.entityVersion()).isNotNull();
        assertThat(reliked.entityVersion()).isNotNull();
        assertThat(unliked.entityVersion()).isGreaterThanOrEqualTo(liked.entityVersion());
        assertThat(reliked.entityVersion()).isGreaterThanOrEqualTo(unliked.entityVersion());

        var put = outbox.put(reliked).put();
        assertThat(put.item().get("entityVersion").n()).isEqualTo(reliked.entityVersion().toString());
    }
}
