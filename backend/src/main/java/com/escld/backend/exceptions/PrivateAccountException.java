package com.escld.backend.exceptions;

public class PrivateAccountException extends RuntimeException {

    public PrivateAccountException() {
        super("This account is private");
    }
}
