package com.escld.backend.exceptions;

public class NotPostOwnerException extends RuntimeException {

    public NotPostOwnerException() {
        super("You can only modify your own posts");
    }
}
