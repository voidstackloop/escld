package com.escld.backend.post;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Shared by PostServiceImpl and LiveStreamServiceImpl — both create rows in
 * the same `posts`/`post_tags` tables, so both need the exact same
 * normalization the `post_tags.tag` CHECK constraint actually enforces
 * (lowercase, digits, underscore only, max 50 chars). Extracted here rather
 * than left duplicated once a second real caller needed it.
 */
public final class TagNormalizer {

    private TagNormalizer() {
    }

    public static Set<String> normalize(List<String> rawTags) {
        if (rawTags == null) {
            return new LinkedHashSet<>();
        }
        Set<String> normalized = new LinkedHashSet<>();
        for (String tag : rawTags) {
            if (tag == null) {
                continue;
            }
            String sanitized = tag.trim().toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9_]", "");
            if (!sanitized.isEmpty()) {
                normalized.add(sanitized.length() > 50 ? sanitized.substring(0, 50) : sanitized);
            }
        }
        return normalized;
    }
}
