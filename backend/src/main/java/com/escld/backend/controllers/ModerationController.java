package com.escld.backend.controllers;

import java.util.List;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.escld.backend.dto.FileReportRequest;
import com.escld.backend.dto.ReportSummary;
import com.escld.backend.dto.ResolveReportRequest;
import com.escld.backend.entities.User;
import com.escld.backend.services.ModerationService;
import com.escld.backend.services.UserService;

import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;

/**
 * Reporting is open to any authenticated user; the queue and every
 * moderation action below require the "admin" or "moderator" Cognito group
 * (see CognitoGroupsConverter) via method-level @PreAuthorize.
 */
@RestController
@RequestMapping("/api/v1/moderation")
@RequiredArgsConstructor
public class ModerationController {

    private final ModerationService moderationService;
    private final UserService userService;

    @PostMapping("/reports")
    @ResponseStatus(HttpStatus.CREATED)
    public ReportSummary fileReport(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody FileReportRequest request) {
        User reporter = currentUser(jwt);
        return moderationService.fileReport(reporter.getId(), request.targetType(), request.targetId(),
                request.reason());
    }

    @GetMapping("/reports")
    @PreAuthorize("hasAnyRole('ADMIN', 'MODERATOR')")
    public List<ReportSummary> openReports() {
        return moderationService.listOpenReports();
    }

    @PostMapping("/reports/{reportId}/resolve")
    @PreAuthorize("hasAnyRole('ADMIN', 'MODERATOR')")
    public void resolveReport(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID reportId,
            @Valid @RequestBody ResolveReportRequest request) {
        User moderator = currentUser(jwt);
        moderationService.resolveReport(reportId, moderator.getId(), request.note());
    }

    @PostMapping("/users/{username}/suspend")
    @PreAuthorize("hasAnyRole('ADMIN', 'MODERATOR')")
    public void suspendUser(@AuthenticationPrincipal Jwt jwt, @PathVariable String username) {
        moderationService.suspendUser(currentUser(jwt).getId(), username);
    }

    @PostMapping("/users/{username}/reinstate")
    @PreAuthorize("hasAnyRole('ADMIN', 'MODERATOR')")
    public void reinstateUser(@AuthenticationPrincipal Jwt jwt, @PathVariable String username) {
        moderationService.reinstateUser(currentUser(jwt).getId(), username);
    }

    @PostMapping("/posts/{postId}/remove")
    @PreAuthorize("hasAnyRole('ADMIN', 'MODERATOR')")
    public void removePost(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID postId) {
        moderationService.removePost(currentUser(jwt).getId(), postId);
    }

    @PostMapping("/comments/{commentId}/remove")
    @PreAuthorize("hasAnyRole('ADMIN', 'MODERATOR')")
    public void removeComment(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID commentId) {
        moderationService.removeComment(currentUser(jwt).getId(), commentId);
    }

    private User currentUser(Jwt jwt) {
        return userService.getOrProvisionByCognitoSub(jwt);
    }
}
