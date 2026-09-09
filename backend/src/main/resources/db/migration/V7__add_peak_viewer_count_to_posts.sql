-- Persisted alongside live_ended_at, at the same moment endLiveStream runs,
-- specifically so it survives past LiveViewerPresenceService's Redis key
-- being cleared on stream end (see LiveStreamServiceImpl.end) — without
-- this, "how many people watched" would only ever exist in the BigQuery
-- warehouse (live.ended's own payload), unreachable from a plain feed read.
-- NULL for every non-live post and for a still-LIVE one (only meaningful
-- once a stream has actually ended).
ALTER TABLE posts ADD COLUMN peak_viewer_count INTEGER;
