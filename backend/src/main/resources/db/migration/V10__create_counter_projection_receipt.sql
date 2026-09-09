CREATE TABLE counter_projection_receipt (
    event_id UUID PRIMARY KEY,
    projection_version INTEGER NOT NULL,
    entity_key TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX counter_projection_receipt_entity_idx
    ON counter_projection_receipt (entity_key, applied_at);
