/** Canonical v2 domain/behavior envelope consumed by the analytics processor.
 * Mirrors bq-sink/src/message-handler.ts EventEnvelope without importing it —
 * analytics ships as an independent deployable. */
export interface DomainEnvelope {
  eventId: string;
  eventType: string;
  eventVersion: string;
  occurredAt: string;
  ingestedAt?: string;
  producer?: string;
  actorId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  entityVersion?: number | null;
  correlationId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  experimentId?: string | null;
  experimentVariant?: string | null;
  payload: Record<string, unknown>;
}

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isValidTimestamp(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  return Number.isFinite(Date.parse(value));
}

export function isDomainEnvelope(value: unknown): value is DomainEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const commonValid =
    typeof v.eventId === "string" &&
    typeof v.eventType === "string" &&
    (v.eventVersion === "1" || v.eventVersion === "2") &&
    typeof v.occurredAt === "string" &&
    isValidTimestamp(v.occurredAt) &&
    typeof v.payload === "object" &&
    v.payload !== null;
  if (!commonValid) return false;
  if (v.eventVersion === "1") return true;
  return (
    typeof v.ingestedAt === "string" &&
    isValidTimestamp(v.ingestedAt) &&
    typeof v.producer === "string" &&
    optionalString(v.actorId) &&
    optionalString(v.entityType) &&
    optionalString(v.entityId) &&
    (v.entityVersion === undefined || v.entityVersion === null || Number.isSafeInteger(v.entityVersion)) &&
    optionalString(v.correlationId) &&
    optionalString(v.sessionId) &&
    optionalString(v.requestId) &&
    optionalString(v.experimentId) &&
    optionalString(v.experimentVariant)
  );
}

/** Maps v2 domain eventTypes to (entityKind, weight) for trending.
 * Qualified-exposure gating (min 20 viewers) and dwell/hide labels live in
 * the warehouse; the online processor uses lightweight weights for serving. */
export function trendingContribution(
  eventType: string
): { kind: "post" | "hashtag" | null; weight: number } {
  switch (eventType) {
    case "post.created":
      return { kind: "post", weight: 1 };
    case "post.liked":
      return { kind: "post", weight: 3 };
    case "post.commented":
      return { kind: "post", weight: 5 };
    default:
      return { kind: null, weight: 0 };
  }
}
