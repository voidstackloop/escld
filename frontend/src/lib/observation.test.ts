import { describe, expect, it, vi } from "vitest"

import { ObservationQueue, type ObservationEvent } from "@/lib/observation"

function event(eventId: string): ObservationEvent {
  return {
    eventId,
    type: "post.impression",
    occurredAt: "2026-09-06T12:00:00.000Z",
    sessionId: "00000000-0000-0000-0000-000000000001",
    observationToken: "signed-token",
    payload: { visibleDurationMs: 1000, visibleFraction: 0.75 },
  }
}

describe("ObservationQueue", () => {
  it("batches events and does not enqueue duplicate event IDs", async () => {
    const sender = vi.fn().mockResolvedValue({
      acceptedEventIds: ["event-1", "event-2"],
      rejected: [],
      retryableEventIds: [],
    })
    const queue = new ObservationQueue(sender)
    queue.enqueue(event("event-1"))
    queue.enqueue(event("event-1"))
    queue.enqueue(event("event-2"))

    await queue.flushNow()

    expect(sender).toHaveBeenCalledOnce()
    expect(sender.mock.calls[0]?.[0]).toHaveLength(2)
  })

  it("retries only retryable and unclassified events with stable IDs", async () => {
    const sender = vi
      .fn()
      .mockResolvedValueOnce({
        acceptedEventIds: ["accepted"],
        rejected: [{ eventId: "rejected", code: "invalid_token" }],
        retryableEventIds: ["retryable"],
      })
      .mockResolvedValueOnce({
        acceptedEventIds: ["retryable", "unclassified"],
        rejected: [],
        retryableEventIds: [],
      })
    const queue = new ObservationQueue(sender)
    for (const id of ["accepted", "rejected", "retryable", "unclassified"]) queue.enqueue(event(id))

    await queue.flushNow()
    await queue.flushNow()

    expect(sender.mock.calls[1]?.[0].map(({ eventId }: ObservationEvent) => eventId)).toEqual([
      "retryable",
      "unclassified",
    ])
  })
})
