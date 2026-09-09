package com.escld.backend.feed;

public class FeedSnapshotExpiredException extends RuntimeException {
    public FeedSnapshotExpiredException() {
        super("Feed session expired; refresh the feed to continue");
    }
}
