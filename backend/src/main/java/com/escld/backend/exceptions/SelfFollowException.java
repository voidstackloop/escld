package com.escld.backend.exceptions;

public class SelfFollowException extends RuntimeException {

    public SelfFollowException() {
        super("You cannot follow yourself");
    }
}
