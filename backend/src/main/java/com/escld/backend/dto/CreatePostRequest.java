package com.escld.backend.dto;

import java.util.List;

import com.escld.backend.post.PostMediaType;

import jakarta.validation.constraints.Size;

public record CreatePostRequest(
        @Size(max = 500, message = "Post text must be at most 500 characters")
        String text,

        String mediaKey,

        PostMediaType mediaType,

        @Size(max = 10, message = "A post can have at most 10 tags")
        List<@Size(max = 50, message = "Each tag must be at most 50 characters") String> tags) {
}
