-- Applies generate_likes.py's per-post like counts to posts.like_count —
-- bypassing the real LikeServiceImpl.like() path (which normally increments
-- this on every call) means this denormalized counter needs a matching bulk
-- update once the DynamoDB like items themselves have been written.
CREATE TEMP TABLE seed_like_counts (post_id UUID, cnt INT);
\copy seed_like_counts FROM '/tmp/seed_like_counts.csv' WITH CSV

UPDATE posts p
SET like_count = c.cnt
FROM seed_like_counts c
WHERE p.id = c.post_id;

SELECT count(*) AS posts_updated FROM seed_like_counts;
