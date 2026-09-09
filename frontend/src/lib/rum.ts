import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from "web-vitals"
import { logger } from "./logger"

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080"

/**
 * Frontend RUM (Real User Monitoring) — Core Web Vitals only, via the
 * standard `web-vitals` library, reported to the backend's
 * POST /api/v1/client-metrics rather than a dedicated RUM SaaS. Same
 * self-hosted-over-vendor call already made for frontend error reporting
 * (see client-error-reporter.ts) — one less vendor relationship/bundle-size
 * cost for a single frontend, and these land as EMF metrics in the same
 * CloudWatch dashboard every other custom metric already uses.
 *
 * Fire-and-forget, matching reportClientError: a failed report must never
 * surface to the user or throw. `keepalive: true` lets the request survive
 * page unload, which matters here specifically — web-vitals reports several
 * metrics (LCP, CLS) only once the page is being hidden/unloaded, exactly
 * when a plain fetch would otherwise be cancelled.
 */
function reportWebVital(metric: Metric): void {
  logger.info("web vital", { name: metric.name, value: metric.value, rating: metric.rating })

  fetch(`${API_BASE_URL}/api/v1/client-metrics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: metric.name, value: metric.value, rating: metric.rating }),
    keepalive: true,
  }).catch(() => {
    // Best-effort — a failed metric report must never itself surface an error.
  })
}

/** Call once at app startup (see main.tsx) — each of these registers its own
 * PerformanceObserver and calls back exactly once per page load (CLS/LCP
 * fire on visibility change / unload, the others fire as soon as they're
 * measurable). */
export function initRum(): void {
  onCLS(reportWebVital)
  onFCP(reportWebVital)
  onINP(reportWebVital)
  onLCP(reportWebVital)
  onTTFB(reportWebVital)
}
