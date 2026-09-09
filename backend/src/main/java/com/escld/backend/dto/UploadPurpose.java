package com.escld.backend.dto;

import java.util.Set;

public enum UploadPurpose {
    AVATAR("avatars", Set.of("image/jpeg", "image/png", "image/webp", "image/gif")),
    COVER("covers", Set.of("image/jpeg", "image/png", "image/webp", "image/gif")),
    POST("posts", Set.of(
            "image/jpeg", "image/png", "image/webp", "image/gif",
            "video/mp4", "video/webm", "video/quicktime"));

    private final String keyPrefix;
    private final Set<String> allowedContentTypes;

    UploadPurpose(String keyPrefix, Set<String> allowedContentTypes) {
        this.keyPrefix = keyPrefix;
        this.allowedContentTypes = allowedContentTypes;
    }

    public String keyPrefix() {
        return keyPrefix;
    }

    public boolean supports(String contentType) {
        return allowedContentTypes.contains(contentType);
    }

    public Set<String> allowedContentTypes() {
        return allowedContentTypes;
    }
}
