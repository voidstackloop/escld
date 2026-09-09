CREATE TABLE posts (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users (id),
    text             VARCHAR(500),
    media_type       VARCHAR(20),
    media_key        TEXT,
    media_url        TEXT,
    media_status     VARCHAR(20) NOT NULL DEFAULT 'NONE',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ,

    CONSTRAINT posts_text_or_media_check
        CHECK (text IS NOT NULL OR media_key IS NOT NULL),
    CONSTRAINT posts_media_type_check
        CHECK (media_type IS NULL OR media_type IN ('IMAGE', 'VIDEO', 'AUDIO')),
    -- NONE: no media. PROCESSING: video/audio queued for ffmpeg transcode.
    -- READY: playable (images are READY immediately, video/audio once transcoded).
    -- FAILED: transcode gave up after retries.
    CONSTRAINT posts_media_status_check
        CHECK (media_status IN ('NONE', 'PROCESSING', 'READY', 'FAILED'))
);

CREATE INDEX posts_user_id_created_at_idx ON posts (user_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TRIGGER posts_set_updated_at
    BEFORE UPDATE ON posts
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
