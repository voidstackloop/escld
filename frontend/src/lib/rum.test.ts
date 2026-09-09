import { describe, expect, it, vi, beforeEach } from "vitest"
import type { Metric } from "web-vitals"

const handlers: Record<string, (metric: Metric) => void> = {}

vi.mock("web-vitals", () => ({
  onCLS: (cb: (metric: Metric) => void) => { handlers.CLS = cb },
  onFCP: (cb: (metric: Metric) => void) => { handlers.FCP = cb },
  onINP: (cb: (metric: Metric) => void) => { handlers.INP = cb },
  onLCP: (cb: (metric: Metric) => void) => { handlers.LCP = cb },
  onTTFB: (cb: (metric: Metric) => void) => { handlers.TTFB = cb },
}))

import { initRum } from "./rum"

function metric(overrides: Partial<Metric>): Metric {
  return {
    name: "LCP",
    value: 0,
    rating: "good",
    delta: 0,
    id: "test-id",
    entries: [],
    navigationType: "navigate",
    ...overrides,
  } as Metric
}

describe("initRum", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 202 })))
  })

  it("registers a callback for every Core Web Vital", () => {
    initRum()

    expect(Object.keys(handlers).sort()).toEqual(["CLS", "FCP", "INP", "LCP", "TTFB"])
  })

  it("posts the metric name, value, and rating to client-metrics with keepalive set", () => {
    initRum()
    handlers.LCP(metric({ name: "LCP", value: 2412.5, rating: "needs-improvement" }))

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/client-metrics"),
      expect.objectContaining({
        method: "POST",
        keepalive: true,
        body: JSON.stringify({ name: "LCP", value: 2412.5, rating: "needs-improvement" }),
      }),
    )
  })

  it("never throws when the report fails to send", () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")))
    initRum()

    expect(() => handlers.CLS(metric({ name: "CLS", value: 0.1, rating: "good" }))).not.toThrow()
  })
})
