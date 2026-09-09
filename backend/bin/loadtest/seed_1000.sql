-- Load-test seed data: 1000 synthetic users, 1000 posts (tagged), and a
-- random follow graph. Not a Flyway migration and not part of the routine
-- dev seed (bin/db/seed.sh) — run explicitly via bin/loadtest/run.sh.
--
-- Follow edges are computed here (in Postgres, where random sampling and
-- set-based generation are easy) but actually live in DynamoDB, so this
-- script only *exports* the edge list; bin/loadtest/run.sh applies it via
-- the AWS CLI afterward. Same split for post events: posts are inserted
-- here, but "post created" events are published to SQS afterward so the
-- real feed-worker pipeline (embedding + ES index + DynamoDB fan-out) is
-- what actually builds the feeds, not a shortcut.

INSERT INTO users (cognito_sub, username, email, display_name, avatar_url, status)
SELECT
    gen_random_uuid(),
    'seed_user_' || i,
    'seed_user_' || i || '@example.invalid',
    'Seed User ' || i,
    'https://api.dicebear.com/9.x/identicon/svg?seed=seed_user_' || i,
    'ACTIVE'
FROM generate_series(1, 1000) AS i
ON CONFLICT (username) DO NOTHING;

CREATE TEMP TABLE seed_new_posts AS
WITH seed_users AS (
    SELECT id, row_number() OVER (ORDER BY username) AS rn
    FROM users
    WHERE username LIKE 'seed_user_%'
),
templates AS (
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
ins AS (
    INSERT INTO posts (user_id, text, media_status)
    SELECT
        su.id,
        '[SEED] ' || (SELECT t[1 + (su.rn % 10)] FROM templates) || ' (#' || su.rn || ')',
        'NONE'
    FROM seed_users su
    RETURNING id, user_id, text, created_at
)
SELECT * FROM ins;

CREATE TEMP TABLE tag_vocab (tag TEXT);
INSERT INTO tag_vocab (tag) VALUES
    ('tech'), ('sports'), ('music'), ('food'), ('travel'),
    ('gaming'), ('art'), ('science'), ('business'), ('movies');

-- The "WHERE p.id IS NOT NULL" below isn't a no-op: it's what makes this
-- LATERAL subquery actually correlated to the outer row. Without a real
-- reference to p, Postgres has no reason to re-evaluate random()/LIMIT per
-- row and instead evaluates the subquery ONCE and reuses that same result
-- for every post (verified the hard way: every post ended up with the same
-- single tag).
INSERT INTO post_tags (post_id, tag)
SELECT p.id, t.tag
FROM seed_new_posts p
CROSS JOIN LATERAL (
    SELECT tag FROM tag_vocab WHERE p.id IS NOT NULL ORDER BY random() LIMIT (1 + floor(random() * 3)::int)
) t;

-- Random follow graph among the seeded users: each follows 3-8 random others.
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
    (SELECT count(*) FROM seed_follow_edges) AS follow_edges;
