package com.escld.backend.controllers;

import java.util.List;

import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.escld.backend.dto.FollowUserSummary;
import com.escld.backend.entities.User;
import com.escld.backend.services.FollowService;
import com.escld.backend.services.UserService;

import lombok.RequiredArgsConstructor;

/**
 * Pending follow requests directed at the caller (private accounts only —
 * public accounts never generate requests, see FollowServiceImpl.follow).
 */
@RestController
@RequestMapping("/api/v1/follow-requests")
@RequiredArgsConstructor
public class FollowRequestController {

    private final FollowService followService;
    private final UserService userService;

    @GetMapping
    public List<FollowUserSummary> pendingRequests(@AuthenticationPrincipal Jwt jwt) {
        return followService.getPendingRequests(currentUser(jwt).getId());
    }

    @PostMapping("/{username}/accept")
    public void accept(@AuthenticationPrincipal Jwt jwt, @PathVariable String username) {
        User currentUser = currentUser(jwt);
        User requester = userService.getByUsername(username);
        followService.acceptFollowRequest(currentUser.getId(), requester.getId());
    }

    @PostMapping("/{username}/reject")
    public void reject(@AuthenticationPrincipal Jwt jwt, @PathVariable String username) {
        User currentUser = currentUser(jwt);
        User requester = userService.getByUsername(username);
        followService.rejectFollowRequest(currentUser.getId(), requester.getId());
    }

    private User currentUser(Jwt jwt) {
        return userService.getOrProvisionByCognitoSub(jwt);
    }
}
