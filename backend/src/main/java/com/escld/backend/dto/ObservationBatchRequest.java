package com.escld.backend.dto;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public record ObservationBatchRequest(
        @NotEmpty @Size(max = 50) List<@Valid Event> events) {
    public record Event(@NotNull UUID eventId, @NotNull String type, @NotNull Instant occurredAt,
            UUID sessionId, @NotNull String observationToken, Map<String, Object> payload) {}
}
