import { context, defaultTextMapGetter, trace, SpanKind, type Context } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { Message } from "@aws-sdk/client-sqs";

const tracer = trace.getTracer("worker");
// A standalone instance, not the global `propagation.extract()` facade —
// mirrors the backend's SqsTraceContext.java using W3CTraceContextPropagator
// directly rather than GlobalOpenTelemetry.getPropagators(). Matters
// concretely here: without the ADOT NODE_OPTIONS loader actually attached
// (every unit test in this file, since vitest never sets NODE_OPTIONS),
// `propagation` resolves to a no-op that silently extracts nothing — caught
// by this file's own tracing.test.ts on the first real run, not assumed.
const traceContextPropagator = new W3CTraceContextPropagator();

/**
 * Extracts the W3C trace context an SQS message attribute may carry (see the
 * backend's SqsTraceContext.java) and runs `fn` inside a new span that's a
 * child of it — so this worker's own spans, and anything ADOT's Node
 * auto-instrumentation creates inside `fn` (the S3/Postgres calls in
 * job-handler.ts), link back to the request that originally enqueued the
 * job instead of starting a disconnected trace. This is the consumer half
 * of the SQS cross-service tracing gap: AWS SDK auto-instrumentation spans
 * the sendMessage/receiveMessage calls themselves, but never links across
 * the queue on its own (verified directly before writing this — see the
 * X-Ray/APM plan's own notes on why SQS needs manual propagation unlike
 * Kafka or HTTP).
 *
 * Falls back to running `fn` with no extracted parent (a normal,
 * standalone trace) when the attribute is absent — messages already
 * in flight before this shipped, or hand-published for testing.
 */
export async function traceMessageProcessing<T>(
  message: Message,
  spanName: string,
  fn: () => Promise<T>
): Promise<T> {
  const traceparent = message.MessageAttributes?.traceparent?.StringValue;
  const parentContext: Context = traceparent
    ? traceContextPropagator.extract(context.active(), { traceparent }, defaultTextMapGetter)
    : context.active();

  return context.with(parentContext, async () => {
    const span = tracer.startSpan(spanName, { kind: SpanKind.CONSUMER });
    try {
      return await context.with(trace.setSpan(context.active(), span), fn);
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  });
}
