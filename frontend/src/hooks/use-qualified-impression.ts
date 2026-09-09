import * as React from "react"

import { enqueueObservation } from "@/lib/observation"

const MIN_VISIBLE_FRACTION = 0.5
const MIN_VISIBLE_DURATION_MS = 1_000
const DWELL_REPORT_INTERVAL_MS = 5_000
const MAX_DWELL_MS = 3_600_000
const observedTokens = new Set<string>()

/** Records one qualified impression after continuous, foreground visibility. */
export function useQualifiedImpression(observationToken: string | undefined) {
  const elementRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const element = elementRef.current
    if (!element || !observationToken || observedTokens.has(observationToken)) return

    let impressionTimer: ReturnType<typeof setTimeout> | undefined
    let dwellTimer: ReturnType<typeof setInterval> | undefined
    let visibleFraction = 0
    let dwellStartedAt: number | undefined
    let activeDwellMs = 0
    let lastReportedDwellMs = 0
    let observationSequence = 0
    let qualified = false

    const stopImpressionTimer = () => {
      if (impressionTimer !== undefined) clearTimeout(impressionTimer)
      impressionTimer = undefined
    }

    const accumulateDwell = () => {
      if (dwellStartedAt === undefined) return
      activeDwellMs = Math.min(MAX_DWELL_MS, activeDwellMs + performance.now() - dwellStartedAt)
      dwellStartedAt = performance.now()
    }

    const reportDwell = () => {
      accumulateDwell()
      const roundedDwellMs = Math.round(activeDwellMs)
      if (!qualified || roundedDwellMs <= lastReportedDwellMs) return
      observationSequence += 1
      lastReportedDwellMs = roundedDwellMs
      enqueueObservation("post.dwell", observationToken, {
        activeDwellMs: roundedDwellMs,
        observationSequence,
      })
      if (activeDwellMs >= MAX_DWELL_MS && dwellTimer !== undefined) {
        clearInterval(dwellTimer)
        dwellTimer = undefined
        dwellStartedAt = undefined
      }
    }

    const stopDwell = () => {
      reportDwell()
      dwellStartedAt = undefined
      if (dwellTimer !== undefined) clearInterval(dwellTimer)
      dwellTimer = undefined
    }

    const startDwell = () => {
      if (dwellStartedAt !== undefined || activeDwellMs >= MAX_DWELL_MS) return
      dwellStartedAt = performance.now()
      dwellTimer = setInterval(reportDwell, DWELL_REPORT_INTERVAL_MS)
    }

    const startImpressionTimer = () => {
      if (qualified || impressionTimer !== undefined || document.visibilityState !== "visible") return
      impressionTimer = setTimeout(() => {
        impressionTimer = undefined
        if (observedTokens.has(observationToken)) return
        observedTokens.add(observationToken)
        qualified = true
        enqueueObservation("post.impression", observationToken, {
          visibleDurationMs: MIN_VISIBLE_DURATION_MS,
          visibleFraction,
        })
      }, MIN_VISIBLE_DURATION_MS)
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && visibleFraction >= MIN_VISIBLE_FRACTION) {
        startImpressionTimer()
        startDwell()
      } else {
        stopImpressionTimer()
        stopDwell()
      }
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        visibleFraction = entry?.intersectionRatio ?? 0
        if (visibleFraction >= MIN_VISIBLE_FRACTION && document.visibilityState === "visible") {
          startImpressionTimer()
          startDwell()
        } else {
          stopImpressionTimer()
          stopDwell()
        }
      },
      { threshold: [0, MIN_VISIBLE_FRACTION, 1] }
    )

    observer.observe(element)
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => {
      stopImpressionTimer()
      stopDwell()
      observer.disconnect()
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [observationToken])

  return elementRef
}
