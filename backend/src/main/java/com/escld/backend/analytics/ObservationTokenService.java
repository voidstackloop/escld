package com.escld.backend.analytics;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Stateless attribution token; validation requires no per-impression Redis lookup. */
@Component
public class ObservationTokenService {
    private static final String PREFIX = "ot1.";
    private final byte[] key;
    private final Duration ttl;

    public ObservationTokenService(@Value("${app.feed.cursor-signing-key}") String key,
            @Value("${app.analytics.observation-token-ttl:24h}") Duration ttl) {
        if (key == null || key.length() < 32) throw new IllegalArgumentException("Observation signing key is too short");
        this.key = key.getBytes(StandardCharsets.UTF_8);
        this.ttl = ttl;
    }

    public String issue(UUID viewerId, UUID postId, UUID requestId, int position) {
        String payload = viewerId + ":" + postId + ":" + requestId + ":" + position + ":"
                + Instant.now().plus(ttl).getEpochSecond();
        String encoded = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(payload.getBytes(StandardCharsets.UTF_8));
        return PREFIX + encoded + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(sign(encoded));
    }

    public Context verify(UUID viewerId, String token) {
        try {
            if (token == null || !token.startsWith(PREFIX)) throw new IllegalArgumentException();
            String[] parts = token.substring(PREFIX.length()).split("\\.", 2);
            byte[] supplied = Base64.getUrlDecoder().decode(parts[1]);
            if (!MessageDigest.isEqual(sign(parts[0]), supplied)) throw new IllegalArgumentException();
            String raw = new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8);
            String[] fields = raw.split(":", 5);
            Context context = new Context(UUID.fromString(fields[0]), UUID.fromString(fields[1]),
                    UUID.fromString(fields[2]), Integer.parseInt(fields[3]), Long.parseLong(fields[4]));
            if (!context.viewerId().equals(viewerId) || context.expiresAtEpochSecond() < Instant.now().getEpochSecond()) {
                throw new IllegalArgumentException();
            }
            return context;
        } catch (Exception e) {
            throw new IllegalArgumentException("Invalid or expired observation token");
        }
    }

    private byte[] sign(String value) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(value.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    public record Context(UUID viewerId, UUID postId, UUID requestId, int position, long expiresAtEpochSecond) {}
}
