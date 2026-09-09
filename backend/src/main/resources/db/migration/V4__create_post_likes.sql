ALTER TABLE posts ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD CONSTRAINT posts_like_count_check CHECK (like_count >= 0);

CREATE TABLE post_likes (
    post_id     UUID NOT NULL REFERENCES posts (id),
    user_id     UUID NOT NULL REFERENCES users (id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (post_id, user_id)
);

-- Reverse lookup: "which of these posts has this user liked" (feed/profile
-- hydration batches this per page instead of querying per post).
CREATE INDEX post_likes_user_id_idx ON post_likes (user_id);
