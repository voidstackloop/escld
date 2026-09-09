package com.escld.backend.exceptions;

import java.util.UUID;

public class ReportNotFoundException extends RuntimeException {

    public ReportNotFoundException(UUID reportId) {
        super("No report found with id " + reportId);
    }
}
