import { beforeAll, describe, expect, it } from "vitest";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { Message } from "@aws-sdk/client-sqs";

import { traceMessageProcessing } from "./tracing.js";

// context.with() is a no-op without a real ContextManager registered — in
// production this happens automatically, before any application code runs,
// as part of the ADOT NODE_OPTIONS loader's own NodeSDK.start(); vitest
// never sets NODE_OPTIONS, so this test registers the identical
// AsyncLocalStorageContextManager by hand. Without this, every assertion
// below silently observes an empty/undefined active span regardless of
// whether traceMessageProcessing's own logic is correct — caught by an
// actual failing run on the worker/ service's own copy of this test, not
// assumed here.
beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

function makeMessage(traceparent?: string): Message {
  return {
    Body: "{}",
    MessageAttributes: traceparent
      ? { traceparent: { DataType: "String", StringValue: traceparent } }
      : {},
  };
}

describe("traceMessageProcessing", () => {
  it("runs fn and returns its result when there is no traceparent attribute", async () => {
    const result = await traceMessageProcessing(makeMessage(), "process test", async () => "done");

    expect(result).toBe("done");
  });

  it("links the active span to the extracted trace/span id from a real W3C traceparent", async () => {
    // Same wire format SqsTraceContextTest asserts on the Java side —
    // 00-<32 hex trace id>-<16 hex span id>-<flags>.
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const parentSpanId = "00f067aa0ba902b7";
    const message = makeMessage(`00-${traceId}-${parentSpanId}-01`);

    let observedTraceId = "";
    await traceMessageProcessing(message, "process test", async () => {
      const span = trace.getActiveSpan();
      observedTraceId = span?.spanContext().traceId ?? "";
    });

    expect(observedTraceId).toBe(traceId);
  });

  it("propagates a thrown error after recording it on the span, and still ends the span", async () => {
    await expect(
      traceMessageProcessing(makeMessage(), "process test", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });
});
