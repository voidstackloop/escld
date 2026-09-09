-- comments had an index on (post_id, created_at) but none on user_id, even
-- though CommentRepository.findRecentPostIdsByUserId/findAllByUserIdAndDeletedAtIsNull/
-- softDeleteAllByUserId all filter on it. findRecentPostIdsByUserId in
-- particular runs on every FeedServiceImpl.getFeed call (see
-- computeEngagementHistory) — without this index that's a sequential scan
-- of the whole comments table on the hottest read path in the app.
CREATE INDEX comments_user_id_created_at_idx ON comments (user_id, created_at DESC) WHERE deleted_at IS NULL;
