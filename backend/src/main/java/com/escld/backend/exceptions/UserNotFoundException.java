package com.escld.backend.exceptions;

import java.util.UUID;

public class UserNotFoundException extends RuntimeException {

    public UserNotFoundException(UUID userId) {
        super("No user found with id " + userId);
    }

    public UserNotFoundException(String username) {
        super("No user found with username " + username);
    }
}
