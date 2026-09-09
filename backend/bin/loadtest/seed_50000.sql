-- Load-test seed data at 50k-post scale: 4,000 synthetic users, 50,000 posts
-- (tagged), ~75,000 comments, and a random follow graph. Same shape and same
-- downstream pipeline as seed_1000.sql (bin/loadtest/run.sh drives the real
-- SQS -> feed-worker -> Elasticsearch -> DynamoDB fan-out for posts/follows
-- afterward) — this file only adds comments directly, since there's no
-- equivalent async pipeline for those (CommentServiceImpl.createComment is a
-- synchronous Postgres write in the real app too).
--
-- User count is kept well below post count on purpose: the follow-graph
-- generation below is a LATERAL join with ORDER BY random() per follower,
-- identical to seed_1000.sql's proven pattern — its cost scales with user
-- count, not post count, so 4,000 users keeps that step fast while still
-- reaching 50,000 posts (~12.5 posts/user, a realistic creator distribution).
-- Comments use modular-hash row selection instead of LATERAL/ORDER BY
-- random(), since at 75,000 rows a per-row LATERAL sort would be the
-- slowest part of this script by a wide margin.

INSERT INTO users (cognito_sub, username, email, display_name, avatar_url, status)
SELECT
    gen_random_uuid(),
    'seed_user_' || i,
    'seed_user_' || i || '@example.invalid',
    'Seed User ' || i,
    'https://api.dicebear.com/9.x/identicon/svg?seed=seed_user_' || i,
    'ACTIVE'
FROM generate_series(1, 4000) AS i
ON CONFLICT (username) DO NOTHING;

CREATE TEMP TABLE seed_user_ids AS
SELECT id, (row_number() OVER (ORDER BY username))::int AS rn
FROM users
WHERE username LIKE 'seed_user_%';

CREATE TEMP TABLE seed_new_posts AS
WITH templates AS (
    SELECT ARRAY[
        'Just shipped something new today.',
        'Thinking a lot about this lately.',
        'Can''t stop listening to this.',
        'Best trip ever, highly recommend.',
        'Who else is excited for the weekend?',
        'New personal record today!',
        'Learned something new and it changed my perspective.',
        'Hot take: this is underrated.',
        'Anyone else into this?',
        'Small update, big difference.'
    ] AS t
),
gen AS (
    -- Multiplicative hash spreads post-to-author assignment evenly without
    -- an ORDER BY random() per row — cheap at 50k rows, and avoids the
    -- degenerate case of every user's posts landing in one contiguous block.
    SELECT
        i,
        1 + ((i::bigint * 2654435761) % 4000)::int AS author_rn,
        now() - (((i::bigint * 999331) % 90) || ' days')::interval
              - (((i::bigint * 15485863) % 86400) || ' seconds')::interval AS post_created_at
    FROM generate_series(1, 50000) AS i
),
ins AS (
    INSERT INTO posts (user_id, text, media_status, created_at)
    SELECT
        su.id,
        '[SEED] ' || (SELECT t[1 + (g.i % 10)] FROM templates) || ' (#' || g.i || ')',
        'NONE',
        g.post_created_at
    FROM gen g
    JOIN seed_user_ids su ON su.rn = g.author_rn
    RETURNING id, user_id, text, created_at
)
SELECT (row_number() OVER (ORDER BY id))::int AS rn, * FROM ins;

CREATE TEMP TABLE tag_vocab (tag TEXT);
INSERT INTO tag_vocab (tag) VALUES
    ('tech'), ('sports'), ('music'), ('food'), ('travel'),
    ('gaming'), ('art'), ('science'), ('business'), ('movies');

-- Per-post LATERAL against a fixed 10-row table is cheap regardless of post
-- count (same reasoning/pattern as seed_1000.sql) — the "WHERE p.id IS NOT
-- NULL" correlation is load-bearing, not decorative (see seed_1000.sql's own
-- comment on this: without it Postgres evaluates the subquery once and
-- reuses it for every row).
INSERT INTO post_tags (post_id, tag)
SELECT p.id, t.tag
FROM seed_new_posts p
CROSS JOIN LATERAL (
    SELECT tag FROM tag_vocab WHERE p.id IS NOT NULL ORDER BY random() LIMIT (1 + floor(random() * 3)::int)
) t;

CREATE TEMP TABLE seed_new_comments AS
WITH comment_templates AS (
    SELECT ARRAY[
        'Great post!', 'Love this.', 'So true.', 'Nice one!', 'Interesting take.',
        'Thanks for sharing.', 'This made my day.', 'Couldn''t agree more.',
        'Wow, amazing.', 'Well said.'
    ] AS t
),
gen AS (
    SELECT
        i,
        1 + ((i::bigint * 40503) % 50000)::int AS post_rn,
        1 + ((i::bigint * 2654435761) % 4000)::int AS commenter_rn,
        i % 3600 AS delay_seconds
    FROM generate_series(1, 75000) AS i
),
ins AS (
    INSERT INTO comments (post_id, user_id, text, created_at)
    SELECT
        p.id,
        u.id,
        (SELECT t[1 + (g.i % 10)] FROM comment_templates),
        p.created_at + (g.delay_seconds || ' seconds')::interval
    FROM gen g
    JOIN seed_new_posts p ON p.rn = g.post_rn
    JOIN seed_user_ids u ON u.rn = g.commenter_rn
    RETURNING id, post_id
)
SELECT * FROM ins;

-- The real create-comment path increments posts.comment_count on every
-- insert (CommentServiceImpl -> PostService#incrementCommentCount) — this
-- script bypasses that application code entirely, so the denormalized
-- counter needs a matching bulk update or every seeded post would show 0
-- comments despite genuinely having some.
UPDATE posts p
SET comment_count = c.cnt
FROM (SELECT post_id, count(*) AS cnt FROM seed_new_comments GROUP BY post_id) c
WHERE p.id = c.post_id;

-- Random follow graph among the seeded users: each follows 3-8 random
-- others. Identical LATERAL/ORDER BY random() pattern to seed_1000.sql,
-- just against 4,000 rows instead of 1,000 (still cheap — this scales with
-- user count, not post count).
CREATE TEMP TABLE seed_follow_edges AS
SELECT DISTINCT follower.id AS follower_id, followee.id AS followee_id
FROM (SELECT id FROM users WHERE username LIKE 'seed_user_%') follower
CROSS JOIN LATERAL (
    SELECT id
    FROM users
    WHERE username LIKE 'seed_user_%' AND id <> follower.id
    ORDER BY random()
    LIMIT (3 + floor(random() * 6)::int)
) followee;

\copy (SELECT id, username FROM users WHERE username LIKE 'seed_user_%' ORDER BY username) TO '/tmp/seed_users.csv' WITH CSV
\copy (SELECT follower_id, followee_id FROM seed_follow_edges) TO '/tmp/seed_follows.csv' WITH CSV
\copy (SELECT p.id, p.user_id, p.text, p.created_at, COALESCE(string_agg(pt.tag, '|'), '') AS tags FROM seed_new_posts p LEFT JOIN post_tags pt ON pt.post_id = p.id GROUP BY p.id, p.user_id, p.text, p.created_at ORDER BY p.created_at) TO '/tmp/seed_posts.csv' WITH CSV

SELECT
    (SELECT count(*) FROM seed_new_posts) AS posts_inserted,
    (SELECT count(*) FROM seed_new_comments) AS comments_inserted,
    (SELECT count(*) FROM seed_follow_edges) AS follow_edges;
