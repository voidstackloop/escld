CREATE TABLE warehouse_outbox (
    id              UUID PRIMARY KEY,
    event_type      VARCHAR(80) NOT NULL,
    event_version   VARCHAR(16) NOT NULL,
    partition_key   VARCHAR(200) NOT NULL,
    occurred_at     TIMESTAMPTZ NOT NULL,
    producer        VARCHAR(80) NOT NULL,
    actor_id        UUID,
    entity_type     VARCHAR(80),
    entity_id       VARCHAR(200),
    entity_version  BIGINT,
    correlation_id  VARCHAR(128),
    payload         JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    available_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_by      UUID,
    claimed_until   TIMESTAMPTZ,
    attempts        INTEGER NOT NULL DEFAULT 0,
    sent_at         TIMESTAMPTZ,
    last_error      VARCHAR(2000),

    CONSTRAINT warehouse_outbox_attempts_check CHECK (attempts >= 0),
    CONSTRAINT warehouse_outbox_claim_check CHECK (
        (claimed_by IS NULL AND claimed_until IS NULL)
        OR (claimed_by IS NOT NULL AND claimed_until IS NOT NULL)
    )
);

CREATE INDEX warehouse_outbox_pending_idx
    ON warehouse_outbox (available_at, occurred_at, id)
    WHERE sent_at IS NULL;

CREATE INDEX warehouse_outbox_partition_order_idx
    ON warehouse_outbox (partition_key, occurred_at, id)
    WHERE sent_at IS NULL;

CREATE INDEX warehouse_outbox_sent_at_idx
    ON warehouse_outbox (sent_at)
    WHERE sent_at IS NOT NULL;
