package com.escld.backend.entities;

import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

import org.hibernate.annotations.Generated;
import org.hibernate.annotations.UuidGenerator;
import org.hibernate.generator.EventType;

import com.escld.backend.user.UserStatus;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Entity
@Table(name = "users")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Data
@Builder
public class User {

    @Id
    @GeneratedValue
    @UuidGenerator
    private UUID id;

    @Column(name = "cognito_sub", nullable = false, updatable = false, unique = true)
    private UUID cognitoSub;

    @Column(nullable = false, unique = true, length = 30, columnDefinition = "citext")
    private String username;

    @Column(nullable = false, unique = true, columnDefinition = "citext")
    private String email;

    @Column(name = "display_name", nullable = false, length = 50)
    private String displayName;

    @Column(length = 160)
    private String bio;

    @Column(name = "avatar_url")
    private String avatarUrl;

    @Column(name = "cover_image_url")
    private String coverImageUrl;

    @Column(length = 100)
    private String location;

    @Column(name = "website_url")
    private String websiteUrl;

    private LocalDate birthdate;
    @Builder.Default
    @Column(name = "is_verified", nullable = false)
    private boolean verified = false;
    @Builder.Default
    @Column(name = "is_private", nullable = false)
    private boolean privateAccount = false;
    @Builder.Default
    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private UserStatus status = UserStatus.ACTIVE;
    @Builder.Default
    @Column(name = "followers_count", nullable = false)
    private int followersCount = 0;
    @Builder.Default
    @Column(name = "following_count", nullable = false)
    private int followingCount = 0;
    @Builder.Default
    @Column(name = "posts_count", nullable = false)
    private int postsCount = 0;
    @Generated(event = EventType.INSERT)
    @Column(name = "created_at", nullable = false, insertable = false, updatable = false)
    private Instant createdAt;

    @Generated(event = { EventType.INSERT, EventType.UPDATE })
    @Column(name = "updated_at", nullable = false, insertable = false, updatable = false)
    private Instant updatedAt;

    @Column(name = "deleted_at")
    private Instant deletedAt;

    /** RTMP publish credential (see rtmp/ and LiveController) — null until the
     * user requests one, opaque, not a Cognito credential. Never rendered in
     * any *Response DTO; only StreamKeyResponse (the direct return value of
     * generating/rotating it) ever exposes the value. */
    @Column(name = "stream_key")
    private UUID streamKey;
}
