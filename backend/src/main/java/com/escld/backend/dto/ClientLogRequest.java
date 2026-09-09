package com.escld.backend.dto;

import java.util.Map;

import jakarta.validation.constraints.NotBlank;

public record ClientLogRequest(
        @NotBlank(message = "message is required")
        String message,

        Map<String, Object> context) {
}
