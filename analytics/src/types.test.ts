import { describe, expect, it } from "vitest";

import { isAnalyticsEvent } from "./types.js";

describe("isAnalyticsEvent", () => {
  it("accepts a minimal valid event", () => {
    expect(isAnalyticsEvent({ type: "post_created", postId: "post-1" })).toBe(true);
  });

  it("accepts a fully populated event", () => {
    expect(
      isAnalyticsEvent({
        type: "post_liked",
        postId: "post-1",
        authorId: "author-1",
        tags: ["a", "b"],
        createdAt: "2026-01-01T00:00:00.000Z",
        correlationId: "corr-1",
      })
    ).toBe(true);
  });

  it("rejects an unknown event type", () => {
    expect(isAnalyticsEvent({ type: "post_deleted", postId: "post-1" })).toBe(false);
  });

  it("rejects a missing postId", () => {
    expect(isAnalyticsEvent({ type: "post_created" })).toBe(false);
  });

  it("rejects tags that aren't all strings", () => {
    expect(isAnalyticsEvent({ type: "post_created", postId: "post-1", tags: ["ok", 5] })).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(isAnalyticsEvent(null)).toBe(false);
    expect(isAnalyticsEvent("post_created")).toBe(false);
    expect(isAnalyticsEvent(42)).toBe(false);
  });
});
