package com.escld.backend.exceptions;

import java.util.UUID;

public class PostNotFoundException extends RuntimeException {

    public PostNotFoundException(UUID postId) {
        super("No post found with id " + postId);
    }
}
