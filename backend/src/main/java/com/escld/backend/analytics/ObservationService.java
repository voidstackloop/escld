package com.escld.backend.analytics;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.escld.backend.dto.ObservationBatchRequest;
import com.escld.backend.dto.ObservationBatchResponse;
import com.escld.backend.warehouse.WarehouseEventPublisher;

@Service
public class ObservationService {
    private static final Set<String> ALLOWED_TYPES = Set.of("post.impression", "post.dwell", "media.progress");
    private final ObservationTokenService tokens;
    private final WarehouseEventPublisher publisher;

    public ObservationService(ObservationTokenService tokens, WarehouseEventPublisher publisher) {
        this.tokens = tokens;
        this.publisher = publisher;
    }

    @Transactional
    public ObservationBatchResponse accept(UUID viewerId, ObservationBatchRequest batch) {
        List<UUID> accepted = new ArrayList<>();
        List<ObservationBatchResponse.Rejected> rejected = new ArrayList<>();
        List<UUID> retryable = new ArrayList<>();
        Instant now = Instant.now();
        for (ObservationBatchRequest.Event event : batch.events()) {
            String error = validate(event, now);
            ObservationTokenService.Context context = null;
            if (error == null) {
                try { context = tokens.verify(viewerId, event.observationToken()); }
                catch (IllegalArgumentException invalid) { error = "INVALID_OBSERVATION_TOKEN"; }
            }
            if (error != null) {
                rejected.add(new ObservationBatchResponse.Rejected(event.eventId(), error));
                continue;
            }
            // Clamp tolerated future skew (up to +2m per validate) to receipt
            // time; preserve the original client timestamp for audit.
            Instant storedOccurredAt = event.occurredAt();
            Map<String, Object> payload = event.payload() == null ? Map.of() : event.payload();
            if (storedOccurredAt.isAfter(now)) {
                Map<String, Object> clamped = new java.util.HashMap<>(payload);
                clamped.put("clientOccurredAt", storedOccurredAt.toString());
                payload = clamped;
                storedOccurredAt = now;
            }
            try {
                publisher.publishObservation(event.eventId(), event.type(), storedOccurredAt, viewerId,
                        context.postId(), context.requestId(), context.position(), event.sessionId(),
                        payload);
                accepted.add(event.eventId());
            } catch (RuntimeException transientFailure) {
                // Durable outbox write failed (DB down, deadlock, etc.).
                // Do not fail unrelated valid events; signal the client to
                // retry only this event ID. The stable eventId preserves
                // idempotency on retry via ON CONFLICT DO NOTHING.
                retryable.add(event.eventId());
            }
        }
        return new ObservationBatchResponse(accepted, rejected, retryable);
    }

    private String validate(ObservationBatchRequest.Event event, Instant now) {
        if (!ALLOWED_TYPES.contains(event.type())) return "UNSUPPORTED_EVENT_TYPE";
        if (event.occurredAt().isBefore(now.minus(Duration.ofHours(24)))
                || event.occurredAt().isAfter(now.plus(Duration.ofMinutes(2)))) return "INVALID_OCCURRED_AT";
        if (event.type().equals("post.impression")) {
            Object duration = event.payload() == null ? null : event.payload().get("visibleDurationMs");
            Object fraction = event.payload() == null ? null : event.payload().get("visibleFraction");
            if (!(duration instanceof Number d) || d.longValue() < 0 || d.longValue() > 3_600_000) return "INVALID_DURATION";
            if (!(fraction instanceof Number f) || !Double.isFinite(f.doubleValue())
                    || f.doubleValue() < 0 || f.doubleValue() > 1) return "INVALID_VISIBLE_FRACTION";
        }
        if (event.type().equals("post.dwell")) {
            Object duration = event.payload() == null ? null : event.payload().get("activeDwellMs");
            Object sequence = event.payload() == null ? null : event.payload().get("observationSequence");
            if (!(duration instanceof Number d) || d.longValue() < 0 || d.longValue() > 3_600_000)
                return "INVALID_DURATION";
            if (!(sequence instanceof Number s) || s.longValue() < 1 || s.longValue() > 1_000_000)
                return "INVALID_OBSERVATION_SEQUENCE";
        }
        if (event.type().equals("media.progress")) {
            Object played = event.payload() == null ? null : event.payload().get("mediaPlayedMs");
            Object duration = event.payload() == null ? null : event.payload().get("mediaDurationMs");
            Object sequence = event.payload() == null ? null : event.payload().get("playbackSequence");
            Object milestone = event.payload() == null ? null : event.payload().get("milestonePercent");
            if (!(played instanceof Number p) || p.longValue() < 0 || p.longValue() > 14_400_000)
                return "INVALID_MEDIA_PLAYED";
            if (!(duration instanceof Number d) || d.longValue() <= 0 || d.longValue() > 14_400_000
                    || p.longValue() > d.longValue()) return "INVALID_MEDIA_DURATION";
            if (!(sequence instanceof Number s) || s.longValue() < 1 || s.longValue() > 1_000_000)
                return "INVALID_PLAYBACK_SEQUENCE";
            if (!(milestone instanceof Number m) || !Set.of(0L, 25L, 50L, 75L, 95L).contains(m.longValue()))
                return "INVALID_MEDIA_MILESTONE";
        }
        return null;
    }
}
