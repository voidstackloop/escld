package com.escld.backend.analytics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.UUID;

import org.junit.jupiter.api.Test;

class ObservationTokenServiceTest {
    private final ObservationTokenService tokens = new ObservationTokenService(
            "01234567890123456789012345678901", Duration.ofHours(24));

    @Test
    void tokenRestoresServerIssuedContextAndIsViewerBound() {
        UUID viewer = UUID.randomUUID(), post = UUID.randomUUID(), request = UUID.randomUUID();
        String token = tokens.issue(viewer, post, request, 7);

        var context = tokens.verify(viewer, token);

        assertThat(context.postId()).isEqualTo(post);
        assertThat(context.requestId()).isEqualTo(request);
        assertThat(context.position()).isEqualTo(7);
        assertThatThrownBy(() -> tokens.verify(UUID.randomUUID(), token))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
