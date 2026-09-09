package com.escld.backend.exceptions;

import java.util.UUID;

public class CommentNotFoundException extends RuntimeException {

    public CommentNotFoundException(UUID commentId) {
        super("No comment found with id " + commentId);
    }
}
