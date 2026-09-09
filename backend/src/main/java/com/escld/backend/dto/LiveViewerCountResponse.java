package com.escld.backend.dto;

/** The live concurrent-viewer count for one post, as of the moment this heartbeat/read happened. */
public record LiveViewerCountResponse(int viewerCount) {
}
