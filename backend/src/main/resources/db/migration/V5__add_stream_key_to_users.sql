-- Per-user RTMP ingest credential (see rtmp/ and LiveController) - a random
-- opaque token embedded in the publish URL (rtmp://host/live/<streamKey>),
-- not a Cognito credential. Nullable: generated on first request, not at
-- signup - most users never go live.
ALTER TABLE users ADD COLUMN stream_key UUID;

CREATE UNIQUE INDEX users_stream_key_key ON users (stream_key) WHERE stream_key IS NOT NULL;
