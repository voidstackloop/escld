package com.escld.backend.dto;

import java.time.LocalDate;

import org.hibernate.validator.constraints.URL;

import jakarta.validation.constraints.Past;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Partial profile update — null fields are left unchanged. Constraints only
 * apply to fields that are actually present, since every field is optional.
 */
public record UpdateUserProfileRequest(
        @Pattern(regexp = "^[a-zA-Z0-9_]{3,30}$", message = "Username must be 3-30 characters: letters, numbers, underscore only")
        String username,

        @Size(min = 1, max = 50, message = "Display name must be between 1 and 50 characters")
        String displayName,

        @Size(max = 160, message = "Bio must be at most 160 characters")
        String bio,

        @URL(message = "Avatar URL must be a valid URL")
        @Size(max = 2048)
        String avatarUrl,

        @URL(message = "Cover image URL must be a valid URL")
        @Size(max = 2048)
        String coverImageUrl,

        @Size(max = 100, message = "Location must be at most 100 characters")
        String location,

        @URL(message = "Website URL must be a valid URL")
        @Size(max = 2048)
        String websiteUrl,

        @Past(message = "Birthdate must be in the past")
        LocalDate birthdate,

        Boolean privateAccount) {
}
