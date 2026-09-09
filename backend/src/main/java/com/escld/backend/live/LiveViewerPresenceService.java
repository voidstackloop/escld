package com.escld.backend.live;

import java.util.UUID;

public interface LiveViewerPresenceService {

    /** Records one viewer's presence ping, returning the resulting live concurrent-viewer count. */
    int recordHeartbeat(UUID postId, UUID viewerId);

    /** Current concurrent-viewer count with no side effect on presence itself (still trims stale entries). */
    int getViewerCount(UUID postId);

    /** The highest concurrent-viewer count observed at any point during the stream. */
    int getPeakViewerCount(UUID postId);

    /** Drops all presence state for a post — called once a stream ends. */
    void clear(UUID postId);
}
