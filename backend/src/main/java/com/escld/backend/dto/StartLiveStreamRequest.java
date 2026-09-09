package com.escld.backend.dto;

import java.util.List;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record StartLiveStreamRequest(
        @NotBlank(message = "A live stream needs a title")
        @Size(max = 500, message = "Title must be at most 500 characters")
        String title,

        @Size(max = 2000, message = "Description must be at most 2000 characters")
        String description,

        @Size(max = 10, message = "A stream can have at most 10 tags")
        List<@Size(max = 50, message = "Each tag must be at most 50 characters") String> tags) {
}
