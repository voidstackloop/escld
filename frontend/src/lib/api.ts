import axios from "axios"
import { fetchAuthSession } from "aws-amplify/auth"
import { reportClientError } from "./client-error-reporter"

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080"

const CORRELATION_ID_HEADER = "X-Correlation-Id"

export class ApiError extends Error {
  status: number
  fieldErrors?: Record<string, string>

  constructor(status: number, message: string, fieldErrors?: Record<string, string>) {
    super(message)
    this.status = status
    this.fieldErrors = fieldErrors
  }
}

export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { "Content-Type": "application/json" },
})

api.interceptors.request.use(async (config) => {
  const session = await fetchAuthSession()
  const token = session.tokens?.accessToken?.toString()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  // One correlation ID per request, generated at the edge — the backend
  // echoes it back (see SecurityConfig's CORS exposedHeaders) and threads
  // it through MDC, and downstream async work (SQS-published jobs) carries
  // it further, so a single user action can be traced end to end through
  // structured logs.
  config.headers[CORRELATION_ID_HEADER] = crypto.randomUUID()
  return config
})

api.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? 0
      const body = error.response?.data as
        | { message?: string; fieldErrors?: Record<string, string> }
        | undefined
      const correlationId =
        (error.config?.headers?.[CORRELATION_ID_HEADER] as string | undefined) ?? undefined
      const message = body?.message ?? error.message

      // Only report real failures, not routine 4xx (validation errors,
      // not-found, etc. are expected UI-level outcomes, not incidents) —
      // matches the backend's own HighErrorRate alert only tracking 5xx.
      if (status === 0 || status >= 500) {
        reportClientError(
          "API request failed",
          { url: error.config?.url, method: error.config?.method, status, message },
          correlationId
        )
      }

      throw new ApiError(status, message, body?.fieldErrors)
    }
    throw error
  }
)
