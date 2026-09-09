import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useQualifiedImpression } from "@/hooks/use-qualified-impression"
import { enqueueObservation } from "@/lib/observation"

vi.mock("@/lib/observation", () => ({ enqueueObservation: vi.fn() }))

let emitIntersection: (ratio: number) => void

function ObservedCard({ token }: { token: string }) {
  const ref = useQualifiedImpression(token)
  return <div ref={ref}>post</div>
}

describe("useQualifiedImpression", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(enqueueObservation).mockReset()
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })

    class Observer {
      private readonly callback: IntersectionObserverCallback

      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback
        emitIntersection = (ratio) => {
          this.callback([{ intersectionRatio: ratio } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
        }
      }

      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return [] }
      readonly root = null
      readonly rootMargin = "0px"
      readonly thresholds = [0, 0.5, 1]
    }

    vi.stubGlobal("IntersectionObserver", Observer)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("requires one continuous visible second and reports cumulative dwell on exit", () => {
    render(<ObservedCard token="visibility-token" />)

    act(() => emitIntersection(0.75))
    act(() => vi.advanceTimersByTime(999))
    expect(enqueueObservation).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1))
    expect(enqueueObservation).toHaveBeenNthCalledWith(
      1,
      "post.impression",
      "visibility-token",
      { visibleDurationMs: 1_000, visibleFraction: 0.75 }
    )

    act(() => vi.advanceTimersByTime(1_500))
    act(() => emitIntersection(0.25))
    expect(enqueueObservation).toHaveBeenNthCalledWith(
      2,
      "post.dwell",
      "visibility-token",
      { activeDwellMs: 2_500, observationSequence: 1 }
    )
  })
})
