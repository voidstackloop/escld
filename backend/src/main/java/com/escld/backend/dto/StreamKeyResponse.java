package com.escld.backend.dto;

import java.util.UUID;

/**
 * The only place a stream key's actual value is ever returned — not part of
 * UserResponse/PublicUserResponse, so it never leaks into a profile view.
 */
public record StreamKeyResponse(UUID streamKey) {
}
