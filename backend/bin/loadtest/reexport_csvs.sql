-- Re-exports the CSVs seed_50000.sql normally produces itself, for recovery
-- after /tmp was wiped (WSL VM restart) but the seeded Postgres rows
-- themselves survived (real filesystem, not tmpfs). Reads existing data
-- only — never re-inserts.
\copy (SELECT id, username FROM users WHERE username LIKE 'seed_user_%' ORDER BY username) TO '/tmp/seed_users.csv' WITH CSV
\copy (SELECT p.id, p.user_id, p.text, p.created_at, COALESCE(string_agg(pt.tag, '|'), '') AS tags FROM posts p LEFT JOIN post_tags pt ON pt.post_id = p.id WHERE p.text LIKE '[SEED]%' GROUP BY p.id, p.user_id, p.text, p.created_at ORDER BY p.created_at) TO '/tmp/seed_posts.csv' WITH CSV

SELECT
    (SELECT count(*) FROM users WHERE username LIKE 'seed_user_%') AS users,
    (SELECT count(*) FROM posts WHERE text LIKE '[SEED]%') AS posts;
