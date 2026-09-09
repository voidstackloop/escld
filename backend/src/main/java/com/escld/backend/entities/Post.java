package com.escld.backend.entities;

import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;

import org.hibernate.annotations.BatchSize;
import org.hibernate.annotations.Generated;
import org.hibernate.annotations.UuidGenerator;
import org.hibernate.generator.EventType;

import com.escld.backend.post.LiveStatus;
import com.escld.backend.post.PostMediaStatus;
import com.escld.backend.post.PostMediaType;

import jakarta.persistence.CollectionTable;
import jakarta.persistence.Column;
import jakarta.persistence.ElementCollection;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Entity
@Table(name = "posts")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Data
@Builder
public class Post {

    @Id
    @GeneratedValue
    @UuidGenerator
    private UUID id;

    @Column(name = "user_id", nullable = false, updatable = false)
    private UUID userId;

    @Column(length = 500)
    private String text;

    /** Only ever populated for a LIVE post — a stream's longer-form
     * description, distinct from `text` (used as its title). Null on
     * every other media type. */
    @Column(length = 2000)
    private String description;

    @Enumerated(EnumType.STRING)
    @Column(name = "media_type", length = 20)
    private PostMediaType mediaType;

    /** S3 object key of the original upload — the source ffmpeg transcodes from. */
    @Column(name = "media_key")
    private String mediaKey;

    /** Public playback URL: direct CloudFront URL for images, HLS master playlist for video/audio. */
    @Column(name = "media_url")
    private String mediaUrl;

    @Builder.Default
    @Enumerated(EnumType.STRING)
    @Column(name = "media_status", nullable = false, length = 20)
    private PostMediaStatus mediaStatus = PostMediaStatus.NONE;

    // EAGER because every response DTO needs tags and there's no lazy-load
    // session available once the entity crosses into a cached/serialized
    // form (see Redis caching in CacheConfig). Without @BatchSize, Hibernate
    // issues one secondary SELECT against post_tags per row - so loading N
    // posts (a feed page, a profile grid, findAllById in FeedServiceImpl)
    // was N+1 queries. @BatchSize(50) turns that into ceil(N/50) IN-queries
    // instead, without changing FetchType or any calling code.
    @Builder.Default
    @ElementCollection(fetch = FetchType.EAGER)
    @CollectionTable(name = "post_tags", joinColumns = @JoinColumn(name = "post_id"))
    @Column(name = "tag")
    @BatchSize(size = 50)
    private Set<String> tags = new LinkedHashSet<>();

    @Builder.Default
    @Column(name = "comment_count", nullable = false)
    private int commentCount = 0;

    @Builder.Default
    @Column(name = "like_count", nullable = false)
    private int likeCount = 0;

    // @Generated tells Hibernate to read the DB-assigned value back
    // immediately after INSERT/UPDATE (both columns are DB-defaulted /
    // trigger-maintained, see V2/V3 migrations) instead of leaving the
    // in-memory field null until the entity is re-fetched separately.
    @Generated(event = EventType.INSERT)
    @Column(name = "created_at", nullable = false, insertable = false, updatable = false)
    private Instant createdAt;

    @Generated(event = { EventType.INSERT, EventType.UPDATE })
    @Column(name = "updated_at", nullable = false, insertable = false, updatable = false)
    private Instant updatedAt;

    @Column(name = "deleted_at")
    private Instant deletedAt;

    /** LIVE for the duration of a broadcast, ENDED afterward, null on every
     * non-LIVE post. See LiveStreamService for the state transitions —
     * this column is also what the RTMP server (rtmp/src/store/postgres.rs)
     * reads directly to gate a publish attempt. */
    @Enumerated(EnumType.STRING)
    @Column(name = "live_status", length = 20)
    private LiveStatus liveStatus;

    @Column(name = "live_started_at")
    private Instant liveStartedAt;

    @Column(name = "live_ended_at")
    private Instant liveEndedAt;

    /** Set once, at the same moment liveEndedAt is — see
     * LiveStreamServiceImpl.end() and LiveViewerPresenceService's own doc
     * for why this can't just be read live from Redis after a stream ends.
     * Null for every non-live post and for a still-LIVE one. */
    @Column(name = "peak_viewer_count")
    private Integer peakViewerCount;
}
