package com.escld.backend.dto;

import java.util.UUID;

import com.escld.backend.moderation.ReportTargetType;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public record FileReportRequest(
        @NotNull(message = "Target type is required")
        ReportTargetType targetType,

        @NotNull(message = "Target id is required")
        UUID targetId,

        @NotBlank(message = "A reason is required")
        @Size(max = 500, message = "Reason must be at most 500 characters")
        String reason) {
}
