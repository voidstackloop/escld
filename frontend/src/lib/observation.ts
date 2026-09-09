import { api } from "@/lib/api"

const FLUSH_BATCH_SIZE = 20
const MAX_QUEUE_SIZE = 200
const MAX_ATTEMPTS = 3
const DEFAULT_FLUSH_DELAY_MS = 5_000
const SESSION_STORAGE_KEY = "escld.analytics.session-id"

export type ObservationType = "post.impression" | "post.dwell" | "media.progress"

export type ObservationEvent = {
  eventId: string
  type: ObservationType
  occurredAt: string
  sessionId: string
  observationToken: string
  payload: Record<string, number | string | boolean>
}

type ObservationBatchResponse = {
  acceptedEventIds: string[]
  rejected: Array<{ eventId: string; code: string }>
  retryableEventIds: string[]
}

type QueuedEvent = { event: ObservationEvent; attempts: number }
type SendBatch = (events: ObservationEvent[]) => Promise<ObservationBatchResponse>

async function sendBatch(events: ObservationEvent[]): Promise<ObservationBatchResponse> {
  const response = await api.post<ObservationBatchResponse>("/api/v1/analytics/events", { events })
  return response.data
}

/**
 * Small in-memory queue for low-volume feed observations. Stable event IDs
 * make every retry safe against the backend outbox's idempotency constraint.
 */
export class ObservationQueue {
  private readonly pending = new Map<string, QueuedEvent>()
  private readonly sender: SendBatch
  private readonly flushDelayMs: number
  private timer: ReturnType<typeof setTimeout> | undefined
  private flushing = false

  constructor(sender: SendBatch = sendBatch, flushDelayMs = DEFAULT_FLUSH_DELAY_MS) {
    this.sender = sender
    this.flushDelayMs = flushDelayMs
  }

  enqueue(event: ObservationEvent): void {
    if (this.pending.has(event.eventId)) return
    if (this.pending.size >= MAX_QUEUE_SIZE) {
      const oldestContinuous = [...this.pending.values()].find(
        ({ event: pending }) => pending.type === "post.dwell" || pending.type === "media.progress"
      )
      if (oldestContinuous) this.pending.delete(oldestContinuous.event.eventId)
      else if (event.type === "post.dwell" || event.type === "media.progress") return
      else this.pending.delete(this.pending.keys().next().value as string)
    }
    this.pending.set(event.eventId, { event, attempts: 0 })
    if (this.pending.size >= FLUSH_BATCH_SIZE) {
      void this.flushNow()
    } else {
      this.schedule(this.flushDelayMs)
    }
  }

  async flushNow(): Promise<void> {
    if (this.flushing || this.pending.size === 0) return
    this.flushing = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined

    const batch = [...this.pending.values()].slice(0, FLUSH_BATCH_SIZE)
    for (const queued of batch) this.pending.delete(queued.event.eventId)

    try {
      const result = await this.sender(batch.map(({ event }) => event))
      const accepted = new Set(result.acceptedEventIds)
      const rejected = new Set(result.rejected.map(({ eventId }) => eventId))
      const retryable = new Set(result.retryableEventIds)
      for (const queued of batch) {
        const id = queued.event.eventId
        if (retryable.has(id) || (!accepted.has(id) && !rejected.has(id))) {
          this.retry(queued)
        }
      }
    } catch {
      for (const queued of batch) this.retry(queued)
    } finally {
      this.flushing = false
      if (this.pending.size > 0) {
        const highestAttempt = Math.max(...[...this.pending.values()].map(({ attempts }) => attempts))
        this.schedule(this.flushDelayMs * 2 ** Math.min(highestAttempt, MAX_ATTEMPTS - 1))
      }
    }
  }

  private retry(queued: QueuedEvent): void {
    const attempts = queued.attempts + 1
    if (attempts < MAX_ATTEMPTS) {
      this.pending.set(queued.event.eventId, { ...queued, attempts })
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flushNow()
    }, delayMs)
  }
}

let fallbackSessionId: string | undefined
let defaultQueue: ObservationQueue | undefined

function sessionId(): string {
  if (fallbackSessionId) return fallbackSessionId
  try {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (existing) return (fallbackSessionId = existing)
    const created = crypto.randomUUID()
    sessionStorage.setItem(SESSION_STORAGE_KEY, created)
    return (fallbackSessionId = created)
  } catch {
    return (fallbackSessionId = crypto.randomUUID())
  }
}

export function enqueueObservation(
  type: ObservationType,
  observationToken: string,
  payload: ObservationEvent["payload"]
): void {
  defaultQueue ??= new ObservationQueue()
  defaultQueue.enqueue({
    eventId: crypto.randomUUID(),
    type,
    occurredAt: new Date().toISOString(),
    sessionId: sessionId(),
    observationToken,
    payload,
  })
}
