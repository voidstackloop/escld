package com.escld.backend.live;

import java.util.Optional;
import java.util.UUID;

import com.escld.backend.dto.StartLiveStreamRequest;
import com.escld.backend.entities.Post;

public interface LiveStreamService {

    /**
     * The caller's own currently-active stream, if any — lets the frontend
     * (Live.tsx) recover accurate "am I live right now" state on page load,
     * closing the gap where a user who left the Go Live page mid-stream and
     * came back had no way to know except by attempting to start again and
     * reading the resulting "already live" error.
     */
    Optional<Post> getActiveStream(UUID userId);

    /**
     * Announces a new live stream as a real Post (mediaType=LIVE) — this is
     * what actually makes it show up in followers' feeds and search
     * (PostEventPublisher's existing fan-out pipeline needs no changes at
     * all to handle it) and what the RTMP server's own publish-gate query
     * looks for before accepting an encoder connection (see
     * rtmp/src/store/postgres.rs). Throws if the caller already has an
     * active stream — enforced at the database level too (see the
     * posts_one_live_per_user_idx partial unique index), this check exists
     * only to fail with a clear message instead of a raw constraint
     * violation.
     */
    Post start(UUID userId, StartLiveStreamRequest request);

    /**
     * Ends the caller's own active stream. There is no path parameter for
     * which stream to end — a user can only ever have one live stream at a
     * time, so "my current one" is unambiguous. Throws if the caller has no
     * active stream.
     */
    Post end(UUID userId);
}
