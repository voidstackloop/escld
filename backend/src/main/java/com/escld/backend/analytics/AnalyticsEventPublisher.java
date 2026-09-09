package com.escld.backend.analytics;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import com.escld.backend.config.CorrelationIdFilter;
import com.fasterxml.jackson.databind.ObjectMapper;

import lombok.extern.slf4j.Slf4j;

/**
 * Publishes lightweight engagement events over Redis pub/sub for the
 * analytics service (see analytics/) to consume — trending posts/hashtags.
 * Redis pub/sub rather than SQS: this is a fire-and-forget signal with no
 * delivery guarantee needed (a missed event just slightly under-counts
 * trending, nothing is lost that matters — same "best-effort" trade
 * PostEventPublisher makes for the feed pipeline), and it reuses the Redis
 * connection this app already has for caching instead of standing up
 * another queue.
 */
@Slf4j
@Component
public class AnalyticsEventPublisher {

    private final StringRedisTemplate redisTemplate;
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final String channel;

    public AnalyticsEventPublisher(
            StringRedisTemplate redisTemplate,
            @Value("${app.analytics.events-channel:analytics-events}") String channel) {
        this.redisTemplate = redisTemplate;
        this.channel = channel;
    }

    public void publishPostCreated(UUID postId, UUID authorId, Set<String> tags) {
        publish(Map.of(
                "type", "post_created",
                "postId", postId.toString(),
                "authorId", authorId.toString(),
                "tags", tags == null ? List.of() : List.copyOf(tags)));
    }

    public void publishPostLiked(UUID postId) {
        publish(Map.of("type", "post_liked", "postId", postId.toString()));
    }

    public void publishPostCommented(UUID postId) {
        publish(Map.of("type", "post_commented", "postId", postId.toString()));
    }

    private void publish(Map<String, Object> event) {
        try {
            // Redis pub/sub has no message-attribute mechanism like SQS, so
            // (unlike TranscodeJobPublisher/PostEventPublisher) the
            // correlation ID has to travel as a body field here — lower
            // priority than the other two async hops since these events are
            // fire-and-forget engagement signals, not a user-facing failure
            // path, but still worth cross-referencing when investigating why
            // "trending" looks stale.
            Map<String, Object> withCorrelation = new HashMap<>(event);
            String correlationId = MDC.get(CorrelationIdFilter.MDC_KEY);
            if (correlationId != null) {
                withCorrelation.put("correlationId", correlationId);
            }
            redisTemplate.convertAndSend(channel, objectMapper.writeValueAsString(withCorrelation));
        } catch (Exception e) {
            log.warn("Failed to publish analytics event {}", event.get("type"), e);
        }
    }
}
