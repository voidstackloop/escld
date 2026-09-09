package com.escld.backend.dto;

import java.time.Instant;

public record PresignedUploadResponse(
        String uploadUrl,
        String objectKey,
        String publicUrl,
        Instant expiresAt) {
}
