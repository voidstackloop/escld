package com.escld.backend.entities;

import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

import lombok.NoArgsConstructor;

/** Composite key for PostLike — a pure join row has no reason to carry its own surrogate id. */
@NoArgsConstructor
public class PostLikeId implements Serializable {

    private UUID postId;
    private UUID userId;

    public PostLikeId(UUID postId, UUID userId) {
        this.postId = postId;
        this.userId = userId;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof PostLikeId other)) return false;
        return Objects.equals(postId, other.postId) && Objects.equals(userId, other.userId);
    }

    @Override
    public int hashCode() {
        return Objects.hash(postId, userId);
    }
}
