package com.escld.backend.controllers;

import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.escld.backend.dto.FeedPageResponse;
import com.escld.backend.entities.User;
import com.escld.backend.services.FeedService;
import com.escld.backend.services.UserService;

import lombok.RequiredArgsConstructor;

@RestController
@RequestMapping("/api/v1")
@RequiredArgsConstructor
public class FeedController {

    private static final int MAX_LIMIT = 50;

    private final FeedService feedService;
    private final UserService userService;

    @GetMapping("/feed")
    public FeedPageResponse getFeed(
            @AuthenticationPrincipal Jwt jwt,
            @RequestParam(defaultValue = "20") int limit,
            @RequestParam(required = false) String cursor,
            @RequestParam(required = false) String mode) {
        User viewer = userService.getOrProvisionByCognitoSub(jwt);
        String normalized = normalizeMode(mode);
        return feedService.getFeed(viewer.getId(), Math.min(Math.max(limit, 1), MAX_LIMIT), cursor, normalized);
    }

    private static String normalizeMode(String mode) {
        if (mode == null || mode.isBlank()) return null;
        String lower = mode.toLowerCase();
        if (lower.equals("following") || lower.equals("for_you")) return lower;
        throw new IllegalArgumentException("Invalid mode: " + mode);
    }
}
