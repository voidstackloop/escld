package com.escld.backend.feed;

public class InvalidFeedCursorException extends RuntimeException {
    public InvalidFeedCursorException() {
        super("Invalid feed cursor");
    }
}
