import { logger } from "./logger"

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080"

/**
 * Logs locally (console) and best-effort reports to the backend's
 * POST /api/v1/client-logs, so a frontend crash lands in the same
 * CloudWatch log group as every other service — this app has no dedicated
 * error-tracking SaaS by design (structured logs + alerting cover it at
 * this scale, see docs/BACKEND.md's telemetry notes), so this is the whole
 * story for frontend errors.
 *
 * Fire-and-forget: a failure to report must never surface to the user or
 * throw from here. `correlationId` defaults to a fresh id per report unless
 * the caller already has one — e.g. a failed API call passes the same id
 * its request used, so this error can be cross-referenced against that
 * request's backend logs.
 */
export function reportClientError(
  message: string,
  fields: Record<string, unknown> = {},
  correlationId: string = crypto.randomUUID()
): void {
  logger.error(message, { ...fields, correlationId })

  fetch(`${API_BASE_URL}/api/v1/client-logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Correlation-Id": correlationId },
    body: JSON.stringify({ message, context: fields }),
    // Keeps the request alive through page unload (e.g. an unhandled
    // rejection firing right before navigation) — standard practice for
    // beacon-style error reporting.
    keepalive: true,
  }).catch(() => {
    // Best-effort — a failed error report must never itself surface an error.
  })
}
