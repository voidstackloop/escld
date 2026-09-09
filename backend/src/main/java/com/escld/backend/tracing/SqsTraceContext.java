package com.escld.backend.tracing;

import java.util.HashMap;
import java.util.Map;

import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import software.amazon.awssdk.services.sqs.model.MessageAttributeValue;

/**
 * Propagates the current OpenTelemetry trace context across an SQS hop, as
 * message attributes. Unlike Kafka or HTTP, SQS has no header-like carrier
 * the ADOT javaagent auto-instruments for context propagation — its own AWS
 * SDK instrumentation creates a span for the sendMessage/receiveMessage call
 * itself, but never links that span across the queue to whichever consumer
 * eventually reads the message (confirmed against the OpenTelemetry AWS SDK
 * instrumentation's own documented behavior before writing this — it's a
 * known, real gap, not something this class is working around unnecessarily).
 *
 * Deliberately uses {@link W3CTraceContextPropagator} directly rather than
 * {@code GlobalOpenTelemetry.getPropagators().getTextMapPropagator()} (the
 * env-configured composite this app's OTEL_PROPAGATORS actually registers —
 * tracecontext,baggage,b3,xray, see otel-sidecar.ts's otelEnvVars): this one
 * manual cross-service link should stay on the one universally-supported
 * format regardless of how that HTTP-instrumentation-facing setting is
 * tuned later, and the Node consumers (worker/feed-worker) only need to
 * parse one header format rather than reconstruct the same 4-propagator
 * composite to stay in sync.
 *
 * Shared by both SQS publishers (TranscodeJobPublisher, PostEventPublisher)
 * rather than duplicating the inject call in each — same "one small helper,
 * several call sites" shape as RedisBatchCache/otel-sidecar.ts.
 *
 * `opentelemetry-api` alone (not the SDK) is enough for this — W3C
 * TraceContext's propagator is part of the API spec itself. Reads whatever
 * span is active in the current Context (typically the enclosing HTTP
 * request's own span, since this runs before the SQS SDK call that would
 * otherwise create its own short-lived send span) — with no ADOT javaagent
 * attached (local dev, unit tests), there's no current span, and injection
 * is a genuine no-op, verified directly in SqsTraceContextTest rather than
 * assumed.
 */
public final class SqsTraceContext {

    private SqsTraceContext() {
    }

    /**
     * Returns the current trace context ("traceparent", plus "tracestate" if
     * in use) as SQS message attributes, ready to merge into a
     * SendMessageRequest's own messageAttributes map. Returns an empty map
     * (not null) when there's no active span, so callers can unconditionally
     * merge the result without a null check.
     */
    public static Map<String, MessageAttributeValue> inject() {
        Map<String, String> carrier = new HashMap<>();
        W3CTraceContextPropagator.getInstance().inject(Context.current(), carrier, Map::put);

        Map<String, MessageAttributeValue> attributes = new HashMap<>();
        carrier.forEach((key, value) -> attributes.put(key, MessageAttributeValue.builder()
                .dataType("String")
                .stringValue(value)
                .build()));
        return attributes;
    }
}
