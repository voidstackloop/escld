package com.escld.backend.dto;

import java.time.Instant;
import java.util.Set;
import java.util.UUID;

import com.escld.backend.post.LiveStatus;
import com.escld.backend.post.PostMediaStatus;
import com.escld.backend.post.PostMediaType;

public record PostResponse(
        UUID id,
        UUID authorId,
        String authorUsername,
        String authorDisplayName,
        String authorAvatarUrl,
        String text,
        /** Only ever non-null for mediaType=LIVE — a stream's description,
         * distinct from `text` (its title). */
        String description,
        PostMediaType mediaType,
        String mediaUrl,
        PostMediaStatus mediaStatus,
        Set<String> tags,
        int commentCount,
        int likeCount,
        boolean likedByViewer,
        // True only where the caller actually fetched live trending data (today:
        // the feed — see FeedServiceImpl) and this post's momentum score clears
        // TrendingScoreClient's display threshold. False elsewhere means "not
        // computed for this response", not "confirmed not trending" — a post
        // viewed directly (PostController) always reports false, since that path
        // doesn't fetch trending data at all.
        boolean trending,
        /** Null on every non-LIVE post. LIVE for the duration of a
         * broadcast, ENDED afterward — see LiveStreamService. */
        LiveStatus liveStatus,
        Instant liveStartedAt,
        Instant liveEndedAt,
        /** Null until a LIVE stream ends (see Post.peakViewerCount's own doc) —
         * a live-in-progress viewer count comes from the separate heartbeat
         * endpoint instead (LiveController), not this field. */
        Integer peakViewerCount,
        Instant createdAt) {
}
