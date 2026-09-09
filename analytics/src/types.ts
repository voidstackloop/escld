export type AnalyticsEventType = "post_created" | "post_liked" | "post_commented";

export interface AnalyticsEvent {
  type: AnalyticsEventType;
  postId: string;
  authorId?: string;
  tags?: string[];
  createdAt?: string;
  /** Sourced from MDC on the backend (see AnalyticsEventPublisher) — carried
   * as a body field rather than a message attribute, since Redis pub/sub has
   * no attribute mechanism like SQS. */
  correlationId?: string;
}

export function isAnalyticsEvent(value: unknown): value is AnalyticsEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.type === "post_created" || v.type === "post_liked" || v.type === "post_commented") &&
    typeof v.postId === "string" &&
    (v.tags === undefined || (Array.isArray(v.tags) && v.tags.every((t) => typeof t === "string"))) &&
    (v.correlationId === undefined || typeof v.correlationId === "string")
  );
}

export interface TrendingEntry {
  id: string;
  score: number;
}
