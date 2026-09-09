package com.escld.backend.dto;

import jakarta.validation.constraints.Size;

public record ResolveReportRequest(
        @Size(max = 500, message = "Note must be at most 500 characters")
        String note) {
}
