package com.escld.backend.exceptions;

public class InvalidPostException extends RuntimeException {

    public InvalidPostException(String message) {
        super(message);
    }
}
