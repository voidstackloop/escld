package com.escld.backend.feed;

import java.util.HashMap;
import java.util.Map;

import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import com.escld.backend.config.CorrelationIdFilter;
import com.escld.backend.entities.Post;
import com.escld.backend.metrics.EmfMetrics;
import com.escld.backend.tracing.SqsTraceContext;
import com.fasterxml.jackson.databind.ObjectMapper;

import lombok.extern.slf4j.Slf4j;
import software.amazon.awssdk.services.sqs.SqsClient;
import software.amazon.awssdk.services.sqs.model.MessageAttributeValue;
import software.amazon.awssdk.services.sqs.model.SendMessageRequest;

/**
 * Enqueues a "post created" event for the feed worker (see feed-worker/) to
 * pick up: it embeds the post text, indexes it into Elasticsearch, and fans
 * the post out into followers' DynamoDB feed partitions. Post text is
 * free-form user input, so unlike TranscodeJobPublisher this uses a real
 * JSON mapper rather than hand-building the body.
 *
 * The ObjectMapper is instantiated directly rather than injected: this app
 * has no auto-configured ObjectMapper bean (same reason TranscodeJobPublisher
 * avoids Jackson entirely), so a plain instance is simplest.
 */
@Slf4j
@Component
public class PostEventPublisher {

    private final SqsClient sqsClient;
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final EmfMetrics emfMetrics;
    private final String queueUrl;

    public PostEventPublisher(
            SqsClient sqsClient,
            EmfMetrics emfMetrics,
            @Value("${app.sqs.post-events-queue-url}") String queueUrl) {
        this.sqsClient = sqsClient;
        this.emfMetrics = emfMetrics;
        this.queueUrl = queueUrl;
    }

    public void publishCreated(Post post) {
        try {
            String body = objectMapper.writeValueAsString(Map.of(
                    "eventType", "CREATED",
                    "postId", post.getId().toString(),
                    "authorId", post.getUserId().toString(),
                    "text", post.getText() == null ? "" : post.getText(),
                    "tags", post.getTags(),
                    "createdAt", java.time.Instant.now().toString()));

            SendMessageRequest.Builder request = SendMessageRequest.builder()
                    .queueUrl(queueUrl)
                    .messageBody(body);
            // Same reasoning as TranscodeJobPublisher — message attributes,
            // not body fields, so feed-worker/ can carry the same correlation
            // ID into its own structured logs and link its own X-Ray spans
            // back to this request's trace (see SqsTraceContext).
            Map<String, MessageAttributeValue> attributes = new HashMap<>(SqsTraceContext.inject());
            String correlationId = MDC.get(CorrelationIdFilter.MDC_KEY);
            if (correlationId != null) {
                attributes.put("correlationId", MessageAttributeValue.builder()
                        .dataType("String")
                        .stringValue(correlationId)
                        .build());
            }
            if (!attributes.isEmpty()) {
                request.messageAttributes(attributes);
            }
            sqsClient.sendMessage(request.build());
            emfMetrics.increment("post_events_enqueue_total", Map.of("result", "success"));
        } catch (Exception e) {
            // Best-effort, same reasoning as TranscodeJobPublisher: the post already
            // exists in Postgres. A missed event just means it's absent from
            // followers' feeds and search until reindexed manually — this metric is
            // what makes that failure mode visible/alertable.
            log.error("Failed to enqueue post-created event for post {}", post.getId(), e);
            emfMetrics.increment("post_events_enqueue_total", Map.of("result", "failure"));
        }
    }
}
