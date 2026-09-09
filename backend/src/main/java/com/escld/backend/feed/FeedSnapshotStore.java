package com.escld.backend.feed;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Stores immutable ranked candidate snapshots and issues viewer-bound HMAC
 * cursors. Immutable offsets make retries deterministic without a mutable
 * "pop" operation or cross-request allocation race.
 */
@Component
public class FeedSnapshotStore {

    private static final String CURSOR_PREFIX = "fs1.";
    private static final String CURSOR_V2_PREFIX = "fs2.";
    private static final String KEY_PREFIX = "feed:snapshot:";

    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;
    private final byte[] signingKey;
    private final Duration ttl;

    public FeedSnapshotStore(StringRedisTemplate redis, ObjectMapper objectMapper,
            @Value("${app.feed.cursor-signing-key}") String signingKey,
            @Value("${app.feed.snapshot-ttl:15m}") Duration ttl) {
        if (signingKey == null || signingKey.length() < 32) {
            throw new IllegalArgumentException("Feed cursor signing key must contain at least 32 characters");
        }
        this.redis = redis;
        this.objectMapper = objectMapper;
        this.signingKey = signingKey.getBytes(StandardCharsets.UTF_8);
        this.ttl = ttl;
    }

    public boolean isSnapshotCursor(String cursor) {
        return cursor != null && (cursor.startsWith(CURSOR_PREFIX) || cursor.startsWith(CURSOR_V2_PREFIX));
    }

    public String create(UUID viewerId, List<UUID> rankedPostIds, String sourceCursor, int nextOffset) {
        return create(viewerId, null, rankedPostIds, sourceCursor, nextOffset);
    }

    /** Mode-aware snapshot: cursors are bound to viewer AND mode; cross-mode
     * reuse is rejected as INVALID_FEED_CURSOR. Null mode = legacy path. */
    public String create(UUID viewerId, String mode, List<UUID> rankedPostIds, String sourceCursor, int nextOffset) {
        if (nextOffset >= rankedPostIds.size() && sourceCursor == null) return null;
        UUID snapshotId = UUID.randomUUID();
        Snapshot state = new Snapshot(viewerId, mode, List.copyOf(rankedPostIds), sourceCursor, Instant.now().plus(ttl));
        try {
            redis.opsForValue().set(KEY_PREFIX + snapshotId, objectMapper.writeValueAsString(state), ttl);
        } catch (Exception e) {
            throw new IllegalStateException("Could not persist feed snapshot", e);
        }
        return encode(viewerId, mode, snapshotId, nextOffset);
    }

    public Slice resume(UUID viewerId, String cursor, int limit) {
        return resume(viewerId, cursor, limit, null);
    }

    public Slice resume(UUID viewerId, String cursor, int limit, String expectedMode) {
        Cursor decoded = decode(viewerId, cursor);
        String json = redis.opsForValue().get(KEY_PREFIX + decoded.snapshotId());
        if (json == null) throw new FeedSnapshotExpiredException();
        try {
            Snapshot state = objectMapper.readValue(json, Snapshot.class);
            if (!state.viewerId().equals(viewerId)) throw new InvalidFeedCursorException();
            if (!java.util.Objects.equals(normalizeMode(state.mode()), normalizeMode(expectedMode))
                    || !java.util.Objects.equals(normalizeMode(decoded.mode()), normalizeMode(expectedMode))) {
                throw new InvalidFeedCursorException();
            }
            if (state.expiresAt().isBefore(Instant.now())) throw new FeedSnapshotExpiredException();
            if (decoded.offset() < 0 || decoded.offset() > state.rankedPostIds().size()) {
                throw new InvalidFeedCursorException();
            }
            if (decoded.offset() == state.rankedPostIds().size()) {
                return new Slice(List.of(), null, state.sourceCursor());
            }
            int end = Math.min(decoded.offset() + limit, state.rankedPostIds().size());
            List<UUID> ids = List.copyOf(state.rankedPostIds().subList(decoded.offset(), end));
            String next = end < state.rankedPostIds().size() || state.sourceCursor() != null
                    ? encode(viewerId, expectedMode, decoded.snapshotId(), end) : null;
            return new Slice(ids, next, null);
        } catch (InvalidFeedCursorException | FeedSnapshotExpiredException e) {
            throw e;
        } catch (Exception e) {
            throw new FeedSnapshotExpiredException();
        }
    }

    private String encode(UUID viewerId, UUID snapshotId, int offset) {
        return encode(viewerId, null, snapshotId, offset);
    }

    private String encode(UUID viewerId, String mode, UUID snapshotId, int offset) {
        if (mode == null) {
            String payload = snapshotId + "." + offset;
            return CURSOR_PREFIX + payload + "." + base64(sign(viewingMessage(viewerId, null, payload)));
        }
        String payload = snapshotId + "." + offset + "." + mode;
        return CURSOR_V2_PREFIX + payload + "." + base64(sign(viewingMessage(viewerId, mode, payload)));
    }

    private Cursor decode(UUID viewerId, String cursor) {
        try {
            if (cursor != null && cursor.startsWith(CURSOR_V2_PREFIX)) {
                String[] parts = cursor.substring(CURSOR_V2_PREFIX.length()).split("\\.", 4);
                if (parts.length != 4) throw new InvalidFeedCursorException();
                String payload = parts[0] + "." + parts[1] + "." + parts[2];
                byte[] supplied = Base64.getUrlDecoder().decode(parts[3]);
                if (!MessageDigest.isEqual(sign(viewingMessage(viewerId, parts[2], payload)), supplied)) {
                    throw new InvalidFeedCursorException();
                }
                return new Cursor(UUID.fromString(parts[0]), Integer.parseInt(parts[1]), parts[2]);
            }
            if (!isSnapshotCursor(cursor)) throw new InvalidFeedCursorException();
            String[] parts = cursor.substring(CURSOR_PREFIX.length()).split("\\.", 3);
            if (parts.length != 3) throw new InvalidFeedCursorException();
            String payload = parts[0] + "." + parts[1];
            byte[] supplied = Base64.getUrlDecoder().decode(parts[2]);
            if (!MessageDigest.isEqual(sign(viewingMessage(viewerId, null, payload)), supplied)) {
                throw new InvalidFeedCursorException();
            }
            return new Cursor(UUID.fromString(parts[0]), Integer.parseInt(parts[1]), null);
        } catch (InvalidFeedCursorException e) {
            throw e;
        } catch (Exception e) {
            throw new InvalidFeedCursorException();
        }
    }

    private String viewingMessage(UUID viewerId, String mode, String payload) {
        return viewerId + ":" + (mode == null ? "" : mode) + ":" + payload;
    }

    private static String normalizeMode(String mode) {
        return mode == null ? null : mode.toLowerCase();
    }

    private byte[] sign(String value) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(signingKey, "HmacSHA256"));
            return mac.doFinal(value.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException("Could not sign feed cursor", e);
        }
    }

    private String base64(byte[] value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }

    private record Snapshot(UUID viewerId, String mode, List<UUID> rankedPostIds, String sourceCursor, Instant expiresAt) {}
    private record Cursor(UUID snapshotId, int offset, String mode) {}
    public record Slice(List<UUID> postIds, String nextCursor, String sourceCursor) {}
}
