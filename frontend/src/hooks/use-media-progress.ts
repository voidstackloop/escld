import * as React from "react"

import { enqueueObservation } from "@/lib/observation"

const REPORT_INTERVAL_MS = 5_000
const MAX_MEDIA_DURATION_MS = 14_400_000
const MILESTONES = [25, 50, 75, 95] as const

/** Maintains the union of watched timeline ranges so seeking and replay do not inflate playback. */
export class UniquePlaybackTracker {
  private ranges: Array<[number, number]> = []

  add(startSeconds: number, endSeconds: number): void {
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return
    const start = Math.max(0, startSeconds)
    const end = Math.max(start, endSeconds)
    const merged: Array<[number, number]> = []
    let pending: [number, number] = [start, end]
    for (const range of this.ranges) {
      if (range[1] < pending[0]) merged.push(range)
      else if (pending[1] < range[0]) {
        merged.push(pending)
        pending = range
      } else {
        pending = [Math.min(pending[0], range[0]), Math.max(pending[1], range[1])]
      }
    }
    merged.push(pending)
    this.ranges = merged
  }

  playedMs(): number {
    return Math.round(this.ranges.reduce((total, [start, end]) => total + end - start, 0) * 1_000)
  }
}

/** Reports cumulative unique playback for finite feed videos using the signed recommendation context. */
export function useMediaProgress(observationToken: string | undefined) {
  const mediaRef = React.useRef<HTMLVideoElement>(null)

  React.useEffect(() => {
    const media = mediaRef.current
    if (!media || !observationToken) return

    const tracker = new UniquePlaybackTracker()
    const reportedMilestones = new Set<number>()
    let lastPositionSeconds: number | undefined
    let lastReportedPlayedMs = 0
    let playbackSequence = 0
    let foreground = document.visibilityState === "visible"
    let playing = false

    const durationMs = () => {
      const value = Math.round(media.duration * 1_000)
      return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_MEDIA_DURATION_MS) : 0
    }

    const sample = () => {
      const current = media.currentTime
      if (foreground && playing && !media.seeking
          && lastPositionSeconds !== undefined && current - lastPositionSeconds <= 15) {
        tracker.add(lastPositionSeconds, current)
      }
      lastPositionSeconds = current
    }

    const emit = (milestonePercent: number, playedMs: number, totalMs: number) => {
      playbackSequence += 1
      enqueueObservation("media.progress", observationToken, {
        mediaPlayedMs: playedMs,
        mediaDurationMs: totalMs,
        playbackSequence,
        milestonePercent,
      })
      lastReportedPlayedMs = Math.max(lastReportedPlayedMs, playedMs)
    }

    const report = () => {
      const totalMs = durationMs()
      if (totalMs === 0) return
      const playedMs = Math.min(tracker.playedMs(), totalMs)
      if (playedMs <= lastReportedPlayedMs) return
      const completion = playedMs / totalMs
      const crossed = MILESTONES.filter(
        (milestone) => completion >= milestone / 100 && !reportedMilestones.has(milestone)
      )
      for (const milestone of crossed) {
        reportedMilestones.add(milestone)
        emit(milestone, playedMs, totalMs)
      }
      if (crossed.length === 0 && playedMs - lastReportedPlayedMs >= REPORT_INTERVAL_MS) {
        emit(0, playedMs, totalMs)
      }
    }

    const sampleAndReport = () => {
      sample()
      report()
    }
    const resetPosition = () => {
      lastPositionSeconds = undefined
    }
    const resumePosition = () => {
      lastPositionSeconds = media.currentTime
    }
    const handlePlaying = () => {
      playing = true
      resumePosition()
    }
    const handlePause = () => {
      sample()
      playing = false
      report()
    }
    const handleWaiting = () => {
      sample()
      playing = false
      resetPosition()
      report()
    }
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        sample()
        foreground = false
        resetPosition()
        report()
      } else {
        foreground = true
        if (!media.paused && !media.ended) {
          playing = true
          resumePosition()
        }
      }
    }

    media.addEventListener("playing", handlePlaying)
    media.addEventListener("timeupdate", sampleAndReport)
    media.addEventListener("pause", handlePause)
    media.addEventListener("ended", handlePause)
    media.addEventListener("waiting", handleWaiting)
    media.addEventListener("seeking", resetPosition)
    media.addEventListener("seeked", resumePosition)
    document.addEventListener("visibilitychange", handleVisibility)
    return () => {
      sampleAndReport()
      media.removeEventListener("playing", handlePlaying)
      media.removeEventListener("timeupdate", sampleAndReport)
      media.removeEventListener("pause", handlePause)
      media.removeEventListener("ended", handlePause)
      media.removeEventListener("waiting", handleWaiting)
      media.removeEventListener("seeking", resetPosition)
      media.removeEventListener("seeked", resumePosition)
      document.removeEventListener("visibilitychange", handleVisibility)
    }
  }, [observationToken])

  return mediaRef
}
