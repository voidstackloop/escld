package com.escld.backend.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record CreateCommentRequest(
        @NotBlank(message = "Comment text is required")
        @Size(max = 300, message = "Comment text must be at most 300 characters")
        String text) {
}
