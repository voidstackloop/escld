package com.escld.backend.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

public record PresignedUploadRequest(
        @NotBlank(message = "fileName is required")
        String fileName,

        @NotBlank(message = "contentType is required")
        String contentType,

        @NotNull(message = "purpose is required")
        UploadPurpose purpose) {
}
