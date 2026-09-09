package com.escld.backend.feed;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;

import com.fasterxml.jackson.databind.ObjectMapper;

class FeedSnapshotStoreTest {

    @SuppressWarnings("unchecked")
    @Test
    void cursorIsViewerBoundAndRetriesReturnTheSameImmutableSlice() {
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        ValueOperations<String, String> values = mock(ValueOperations.class);
        AtomicReference<String> stored = new AtomicReference<>();
        when(redis.opsForValue()).thenReturn(values);
        org.mockito.Mockito.doAnswer(call -> { stored.set(call.getArgument(1)); return null; })
                .when(values).set(anyString(), anyString(), any(Duration.class));
        when(values.get(anyString())).thenAnswer(call -> stored.get());
        var store = new FeedSnapshotStore(redis, new ObjectMapper().findAndRegisterModules(),
                "01234567890123456789012345678901", Duration.ofMinutes(15));
        UUID viewer = UUID.randomUUID();
        List<UUID> ids = List.of(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID());

        String cursor = store.create(viewer, ids, "legacy-source", 1);
        FeedSnapshotStore.Slice first = store.resume(viewer, cursor, 1);
        FeedSnapshotStore.Slice retry = store.resume(viewer, cursor, 1);

        assertThat(first.postIds()).containsExactly(ids.get(1));
        assertThat(retry).isEqualTo(first);
        assertThatThrownBy(() -> store.resume(UUID.randomUUID(), cursor, 1))
                .isInstanceOf(InvalidFeedCursorException.class);
    }

    @SuppressWarnings("unchecked")
    @Test
    void missingSnapshotReturnsTheTypedExpiryFailure() {
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        ValueOperations<String, String> values = mock(ValueOperations.class);
        AtomicReference<String> stored = new AtomicReference<>();
        when(redis.opsForValue()).thenReturn(values);
        org.mockito.Mockito.doAnswer(call -> { stored.set(call.getArgument(1)); return null; })
                .when(values).set(anyString(), anyString(), any(Duration.class));
        when(values.get(anyString())).thenReturn(null);
        var store = new FeedSnapshotStore(redis, new ObjectMapper().findAndRegisterModules(),
                "01234567890123456789012345678901", Duration.ofMinutes(15));
        UUID viewer = UUID.randomUUID();
        String cursor = store.create(viewer, List.of(UUID.randomUUID(), UUID.randomUUID()), null, 1);

        assertThatThrownBy(() -> store.resume(viewer, cursor, 1))
                .isInstanceOf(FeedSnapshotExpiredException.class);
    }

    @SuppressWarnings("unchecked")
    @Test
    void cursorsAreModeBoundAndCrossModeReuseIsRejected() {
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        ValueOperations<String, String> values = mock(ValueOperations.class);
        AtomicReference<String> stored = new AtomicReference<>();
        when(redis.opsForValue()).thenReturn(values);
        org.mockito.Mockito.doAnswer(call -> { stored.set(call.getArgument(1)); return null; })
                .when(values).set(anyString(), anyString(), any(Duration.class));
        when(values.get(anyString())).thenAnswer(call -> stored.get());
        var store = new FeedSnapshotStore(redis, new ObjectMapper().findAndRegisterModules(),
                "01234567890123456789012345678901", Duration.ofMinutes(15));
        UUID viewer = UUID.randomUUID();
        List<UUID> ids = List.of(UUID.randomUUID(), UUID.randomUUID());

        String cursor = store.create(viewer, "for_you", ids, null, 1);
        assertThat(cursor.startsWith("fs2.")).isTrue();
        assertThat(store.resume(viewer, cursor, 1, "for_you").postIds()).containsExactly(ids.get(1));
        assertThatThrownBy(() -> store.resume(viewer, cursor, 1, "following"))
                .isInstanceOf(InvalidFeedCursorException.class);
        assertThatThrownBy(() -> store.resume(viewer, cursor, 1, null))
                .isInstanceOf(InvalidFeedCursorException.class);
    }
}
