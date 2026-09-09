package com.escld.backend.post;

/** Only ever set on a Post whose mediaType is LIVE — null on every other
 * post. LIVE for the duration of the broadcast, ENDED afterward; there is
 * no "not started yet" state, since a Post row is only ever created once
 * the broadcaster has actually announced (see LiveStreamService). */
public enum LiveStatus {
    LIVE,
    ENDED
}
