import { describe, expect, it } from "vitest"

import { UniquePlaybackTracker } from "@/hooks/use-media-progress"

describe("UniquePlaybackTracker", () => {
  it("merges overlap so replay does not inflate cumulative playback", () => {
    const tracker = new UniquePlaybackTracker()
    tracker.add(0, 10)
    tracker.add(5, 12)
    tracker.add(20, 25)

    expect(tracker.playedMs()).toBe(17_000)
  })

  it("ignores backwards and invalid ranges", () => {
    const tracker = new UniquePlaybackTracker()
    tracker.add(10, 5)
    tracker.add(Number.NaN, 10)

    expect(tracker.playedMs()).toBe(0)
  })
})
