package com.escld.backend.exceptions;

public class NotCommentOwnerException extends RuntimeException {

    public NotCommentOwnerException() {
        super("You can only delete your own comments");
    }
}
