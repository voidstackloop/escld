ALTER TABLE posts ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD CONSTRAINT posts_comment_count_check CHECK (comment_count >= 0);

CREATE TABLE post_tags (
    post_id  UUID NOT NULL REFERENCES posts (id),
    tag      VARCHAR(50) NOT NULL,

    PRIMARY KEY (post_id, tag),
    CONSTRAINT post_tags_tag_format_check CHECK (tag ~ '^[a-z0-9_]{1,50}$')
);

CREATE INDEX post_tags_tag_idx ON post_tags (tag);

CREATE TABLE comments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id     UUID NOT NULL REFERENCES posts (id),
    user_id     UUID NOT NULL REFERENCES users (id),
    text        VARCHAR(300) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ
);

CREATE INDEX comments_post_id_created_at_idx ON comments (post_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TRIGGER comments_set_updated_at
    BEFORE UPDATE ON comments
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
