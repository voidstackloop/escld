package com.escld.backend.exceptions;

public class FollowRequestNotFoundException extends RuntimeException {

    public FollowRequestNotFoundException() {
        super("No pending follow request found");
    }
}
