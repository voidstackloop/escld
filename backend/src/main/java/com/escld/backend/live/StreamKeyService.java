package com.escld.backend.live;

import java.util.UUID;

public interface StreamKeyService {

    /**
     * Generates a fresh stream key for the given user, overwriting any
     * existing one (so an old, possibly-leaked key immediately stops
     * working — matches the "rotate" behavior every real streaming platform
     * offers, not a separate operation). Returns the new key; it is never
     * retrievable again after this call.
     */
    UUID regenerate(UUID userId);
}
