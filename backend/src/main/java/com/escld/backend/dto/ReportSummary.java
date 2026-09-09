package com.escld.backend.dto;

import java.time.Instant;
import java.util.UUID;

import com.escld.backend.moderation.ReportTargetType;

public record ReportSummary(
        UUID id,
        ReportTargetType targetType,
        UUID targetId,
        UUID reporterId,
        String reason,
        String status,
        Instant createdAt) {
}
