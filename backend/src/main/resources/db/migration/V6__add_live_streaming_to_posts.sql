-- Live streams are posts (mediaType=LIVE) so they reuse the entire existing
-- feed/search/analytics pipeline (PostEventPublisher -> feed-worker ->
-- Elasticsearch + per-follower DynamoDB fan-out, AnalyticsEventPublisher's
-- real-time trending) with zero changes to any of it — see LiveStreamService.
ALTER TABLE posts DROP CONSTRAINT posts_media_type_check;
ALTER TABLE posts ADD CONSTRAINT posts_media_type_check
    CHECK (media_type IS NULL OR media_type IN ('IMAGE', 'VIDEO', 'AUDIO', 'LIVE'));

-- Live-specific fields, unused by every other post. A real column rather
-- than overloading `text` (used as the stream's title): title and
-- description are genuinely two different fields in the "go live" UI, the
-- same way a post's caption and its media are separate concerns.
ALTER TABLE posts ADD COLUMN description VARCHAR(2000);
ALTER TABLE posts ADD COLUMN live_status VARCHAR(20);
ALTER TABLE posts ADD COLUMN live_started_at TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN live_ended_at TIMESTAMPTZ;

ALTER TABLE posts ADD CONSTRAINT posts_live_status_check
    CHECK (live_status IS NULL OR live_status IN ('LIVE', 'ENDED'));

-- Both LiveStreamServiceImpl (announcing a new stream) and the RTMP server's
-- own publish-gate query (rtmp/src/store/postgres.rs) rely on "at most one
-- live post per user" actually being true, not just usually true — a
-- partial unique index enforces it at the database level rather than
-- trusting every call site to check first.
CREATE UNIQUE INDEX posts_one_live_per_user_idx ON posts (user_id) WHERE live_status = 'LIVE';
