package com.escld.backend.controllers;

import java.time.LocalDate;
import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.escld.backend.dto.InsightsHistoryResponse;
import com.escld.backend.dto.PublicUserResponse;
import com.escld.backend.dto.UpdateUserProfileRequest;
import com.escld.backend.dto.UserResponse;
import com.escld.backend.entities.User;
import com.escld.backend.insights.CreatorStudioService;
import com.escld.backend.mappers.UserMapper;
import com.escld.backend.moderation.ModerationStore;
import com.escld.backend.services.AccountDeletionService;
import com.escld.backend.services.UserService;

import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

@Slf4j
@RestController
@RequestMapping("/api/v1/users")
@RequiredArgsConstructor
public class UserController {

    private final UserService userService;
    private final UserMapper userMapper;
    private final ModerationStore moderationStore;
    private final AccountDeletionService accountDeletionService;
    private final CreatorStudioService creatorStudioService;

    @GetMapping("/me")
    public UserResponse getCurrentUser(@AuthenticationPrincipal Jwt jwt) {
        User user = userService.getOrProvisionByCognitoSub(jwt);
        return userMapper.toUserResponse(user);
    }

    @PatchMapping("/me")
    public UserResponse updateCurrentUser(@AuthenticationPrincipal Jwt jwt,
            @Valid @RequestBody UpdateUserProfileRequest request) {
        User current = userService.getOrProvisionByCognitoSub(jwt);
        User updated = userService.updateProfile(current.getId(), request);
        log.info("User {} updated their profile", updated.getId());
        return userMapper.toUserResponse(updated);
    }

    @GetMapping("/{username}")
    public PublicUserResponse getByUsername(@PathVariable String username) {
        return userMapper.toPublicUserResponse(userService.getByUsername(username));
    }

    /** Creator Studio — account-wide historical trends (views/watch-time/
     * likes/comments/new-followers over a date range). See
     * CreatorStudioService's own doc comment for why this is time-series
     * only, not "as of now" totals. Same UTC/inclusive-from/exclusive-to/
     * 503-when-unmaterialized contract as the per-post history endpoint. */
    @GetMapping("/me/insights")
    public InsightsHistoryResponse getCreatorInsights(
            @AuthenticationPrincipal Jwt jwt,
            @RequestParam(required = false) LocalDate from,
            @RequestParam(required = false) LocalDate to,
            @RequestParam(defaultValue = "day") String granularity) {
        if (!"day".equals(granularity)) {
            throw new IllegalArgumentException("Unsupported granularity: " + granularity);
        }
        User current = userService.getOrProvisionByCognitoSub(jwt);
        return creatorStudioService.getInsights(current.getId(), from, to);
    }

    // GDPR "right to be forgotten" — self-service only, deliberately no
    // @PreAuthorize and no moderationStore.logAction (that would create a
    // MOD#<callerId> audit entry, mixing self-service deletions into the
    // moderator audit trail — see AccountDeletionService's javadoc for why
    // that trail is specifically excluded from this capability's own scope).
    @DeleteMapping("/me")
    public ResponseEntity<Void> deleteCurrentUser(@AuthenticationPrincipal Jwt jwt) {
        User current = userService.getOrProvisionByCognitoSub(jwt);
        log.info("User {} deleted their own account", current.getId());
        accountDeletionService.deleteAccount(current.getId());
        return ResponseEntity.noContent().build();
    }

    @PreAuthorize("hasAnyRole('ADMIN', 'MODERATOR')")
    @PostMapping("/{id}/activate")
    public UserResponse activate(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        log.info("Activating user {}", id);
        UserResponse response = userMapper.toUserResponse(userService.activateUser(id));
        moderationStore.logAction(actorId(jwt), "ACTIVATE_USER", "USER", id.toString());
        return response;
    }

    @PreAuthorize("hasAnyRole('ADMIN', 'MODERATOR')")
    @PostMapping("/{id}/suspend")
    public UserResponse suspend(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        log.info("Suspending user {}", id);
        UserResponse response = userMapper.toUserResponse(userService.suspendUser(id));
        moderationStore.logAction(actorId(jwt), "SUSPEND_USER", "USER", id.toString());
        return response;
    }

    @PreAuthorize("hasAnyRole('ADMIN', 'MODERATOR')")
    @PostMapping("/{id}/deactivate")
    public UserResponse deactivate(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        log.info("Deactivating user {}", id);
        UserResponse response = userMapper.toUserResponse(userService.deactivateUser(id));
        moderationStore.logAction(actorId(jwt), "DEACTIVATE_USER", "USER", id.toString());
        return response;
    }

    /** The acting admin/moderator's own users.id — ModerationStore's audit
     * trail keys on this, same as every other call site (see
     * ModerationController). Not the target user's id. */
    private UUID actorId(Jwt jwt) {
        return userService.getOrProvisionByCognitoSub(jwt).getId();
    }
}
