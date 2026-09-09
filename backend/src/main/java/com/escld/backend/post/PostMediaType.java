package com.escld.backend.post;

public enum PostMediaType {
    IMAGE,
    VIDEO,
    AUDIO,
    /** A live stream announcement (see LiveStreamService) — mediaUrl is the
     * live HLS playlist URL, mediaStatus stays READY for its whole
     * lifetime (there's no transcode step, unlike VIDEO/AUDIO), and
     * liveStatus/liveStartedAt/liveEndedAt on the Post track the broadcast
     * itself, a concern no other media type has. */
    LIVE
}
