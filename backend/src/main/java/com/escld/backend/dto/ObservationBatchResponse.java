package com.escld.backend.dto;

import java.util.List;
import java.util.UUID;

public record ObservationBatchResponse(List<UUID> acceptedEventIds, List<Rejected> rejected,
        List<UUID> retryableEventIds) {
    public record Rejected(UUID eventId, String code) {}
}
