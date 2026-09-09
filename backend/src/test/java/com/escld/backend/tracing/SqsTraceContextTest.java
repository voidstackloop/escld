package com.escld.backend.tracing;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;

import org.junit.jupiter.api.Test;

import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import software.amazon.awssdk.services.sqs.model.MessageAttributeValue;

class SqsTraceContextTest {

    @Test
    void neverThrowsAndReturnsAnEmptyMapWithoutAnActiveSpan() {
        // No ADOT javaagent is attached in this test JVM, and no span is
        // ever made current here — confirms the no-agent case (local dev,
        // every other unit test in this suite) is genuinely harmless, not
        // just "assumed fine".
        Map<String, MessageAttributeValue> attributes = SqsTraceContext.inject();

        assertThat(attributes).isNotNull();
        assertThat(attributes).isEmpty();
    }

    @Test
    void encodesARealActiveSpanAsAWellFormedTraceparentAttribute() {
        // Built directly via the API (no SDK/agent needed) — a valid,
        // sampled SpanContext wrapped as a non-recording Span, made current
        // for the duration of the call. Proves the actual wire format this
        // class hands to worker/feed-worker, not just that "some map" comes
        // back.
        SpanContext spanContext = SpanContext.create(
                "4bf92f3577b34da6a3ce929d0e0e4736",
                "00f067aa0ba902b7",
                TraceFlags.getSampled(),
                TraceState.getDefault());
        Span span = Span.wrap(spanContext);

        Map<String, MessageAttributeValue> attributes;
        try (Scope ignored = Context.current().with(span).makeCurrent()) {
            attributes = SqsTraceContext.inject();
        }

        assertThat(attributes).containsKey("traceparent");
        assertThat(attributes.get("traceparent").stringValue())
                .isEqualTo("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
        assertThat(attributes.get("traceparent").dataType()).isEqualTo("String");
    }
}
