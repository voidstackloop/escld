ALTER TABLE warehouse_outbox
    ADD COLUMN session_id UUID,
    ADD COLUMN request_id UUID,
    ADD COLUMN experiment_id VARCHAR(128),
    ADD COLUMN experiment_variant VARCHAR(64);

CREATE INDEX warehouse_outbox_request_idx
    ON warehouse_outbox (request_id)
    WHERE request_id IS NOT NULL;
