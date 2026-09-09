package com.escld.backend.transcode;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import com.escld.backend.config.CorrelationIdFilter;
import com.escld.backend.metrics.EmfMetrics;
import com.escld.backend.post.PostMediaType;
import com.escld.backend.tracing.SqsTraceContext;

import lombok.extern.slf4j.Slf4j;
import software.amazon.awssdk.services.sqs.SqsClient;
import software.amazon.awssdk.services.sqs.model.MessageAttributeValue;
import software.amazon.awssdk.services.sqs.model.SendMessageRequest;

/**
 * Enqueues a transcode job for the ffmpeg worker (see worker/) to pick up.
 * The backend only ever writes to the queue — it never talks to ffmpeg
 * directly, and never blocks a request waiting for a transcode to finish.
 */
@Slf4j
@Component
public class TranscodeJobPublisher {

    private final SqsClient sqsClient;
    private final EmfMetrics emfMetrics;
    private final String queueUrl;

    public TranscodeJobPublisher(
            SqsClient sqsClient,
            EmfMetrics emfMetrics,
            @Value("${app.sqs.transcode-queue-url}") String queueUrl) {
        this.sqsClient = sqsClient;
        this.emfMetrics = emfMetrics;
        this.queueUrl = queueUrl;
    }

    public void publish(UUID postId, String mediaKey, PostMediaType mediaType) {
        try {
            // postId is a UUID and mediaType an enum name — neither can contain JSON-special
            // characters, and mediaKey is a server-generated S3 key (see MediaServiceImpl),
            // so hand-building this tiny fixed-shape payload avoids a Jackson dependency here.
            String body = """
                    {"postId":"%s","mediaKey":"%s","mediaType":"%s"}"""
                    .formatted(postId, mediaKey, mediaType.name());

            SendMessageRequest.Builder request = SendMessageRequest.builder()
                    .queueUrl(queueUrl)
                    .messageBody(body);
            // Message attributes, not body fields — keeps the body's schema
            // stable across DLQ/redrive. worker/ extracts correlationId to carry
            // it into its own structured logs; the trace-context attributes (see
            // SqsTraceContext) let worker/'s own X-Ray spans link back to this
            // request's span instead of starting a disconnected trace.
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
            emfMetrics.increment("transcode_jobs_enqueue_total", Map.of("result", "success"));
        } catch (Exception e) {
            // Best-effort: the post is already saved with PROCESSING status. If enqueueing
            // fails, it'll sit stuck in PROCESSING rather than block post creation — worth
            // a manual requeue/alert, not a reason to fail the user's request. This metric
            // is what actually makes that failure mode visible/alertable instead of only
            // discoverable by reading logs.
            log.error("Failed to enqueue transcode job for post {}", postId, e);
            emfMetrics.increment("transcode_jobs_enqueue_total", Map.of("result", "failure"));
        }
    }
}
