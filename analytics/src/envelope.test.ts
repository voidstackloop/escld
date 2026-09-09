import { describe, expect, it } from "vitest";

import { isDomainEnvelope, trendingContribution } from "./envelope.js";

describe("isDomainEnvelope", () => {
  it("accepts v2 envelopes with typed attribution", () => {
    expect(
      isDomainEnvelope({
        eventId: "evt-1",
        eventType: "post.liked",
        eventVersion: "2",
        occurredAt: "2026-01-01T00:00:00.000Z",
        ingestedAt: "2026-01-01T00:00:00.050Z",
        producer: "backend",
        actorId: "user-1",
        entityType: "post_like",
        entityId: "post-1:user-1",
        entityVersion: 3,
        correlationId: "corr-1",
        sessionId: "session-9",
        requestId: "request-8",
        experimentId: "feed-quality-1",
        experimentVariant: "baseline",
        payload: { postId: "post-1" },
      })
    ).toBe(true);
  });

  it("rejects malformed timestamps", () => {
    expect(
      isDomainEnvelope({
        eventId: "evt-1",
        eventType: "post.liked",
        eventVersion: "2",
        occurredAt: "not-a-date",
        ingestedAt: "2026-01-01T00:00:00.050Z",
        producer: "backend",
        payload: {},
      })
    ).toBe(false);
  });

  it("accepts v1 without ingestedAt/producer", () => {
    expect(
      isDomainEnvelope({
        eventId: "evt-1",
        eventType: "post.created",
        eventVersion: "1",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: { postId: "post-1" },
      })
    ).toBe(true);
  });
});

describe("trendingContribution", () => {
  it("weights engagement types for serving", () => {
    expect(trendingContribution("post.created")).toEqual({ kind: "post", weight: 1 });
    expect(trendingContribution("post.liked")).toEqual({ kind: "post", weight: 3 });
    expect(trendingContribution("post.commented")).toEqual({ kind: "post", weight: 5 });
    expect(trendingContribution("user.followed")).toEqual({ kind: null, weight: 0 });
  });
});
