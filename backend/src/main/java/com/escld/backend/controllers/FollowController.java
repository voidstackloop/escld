package com.escld.backend.controllers;

import java.util.List;

import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.escld.backend.dto.FollowStatus;
import com.escld.backend.dto.FollowUserSummary;
import com.escld.backend.entities.User;
import com.escld.backend.exceptions.PrivateAccountException;
import com.escld.backend.services.FollowService;
import com.escld.backend.services.UserService;

import lombok.RequiredArgsConstructor;

@RestController
@RequestMapping("/api/v1/users")
@RequiredArgsConstructor
public class FollowController {

    private final FollowService followService;
    private final UserService userService;

    @PostMapping("/{username}/follow")
    public FollowStatus follow(@AuthenticationPrincipal Jwt jwt, @PathVariable String username) {
        User currentUser = currentUser(jwt);
        User target = userService.getByUsername(username);
        return new FollowStatus(followService.follow(currentUser.getId(), target.getId()));
    }

    @DeleteMapping("/{username}/follow")
    public void unfollow(@AuthenticationPrincipal Jwt jwt, @PathVariable String username) {
        User currentUser = currentUser(jwt);
        User target = userService.getByUsername(username);
        followService.unfollow(currentUser.getId(), target.getId());
    }

    @GetMapping("/{username}/follow-status")
    public FollowStatus followStatus(@AuthenticationPrincipal Jwt jwt, @PathVariable String username) {
        User currentUser = currentUser(jwt);
        User target = userService.getByUsername(username);
        return new FollowStatus(followService.getFollowState(currentUser.getId(), target.getId()));
    }

    @GetMapping("/{username}/followers")
    public List<FollowUserSummary> followers(@AuthenticationPrincipal Jwt jwt, @PathVariable String username) {
        User target = userService.getByUsername(username);
        requireVisible(currentUser(jwt), target);
        return followService.getFollowers(target.getId());
    }

    @GetMapping("/{username}/following")
    public List<FollowUserSummary> following(@AuthenticationPrincipal Jwt jwt, @PathVariable String username) {
        User target = userService.getByUsername(username);
        requireVisible(currentUser(jwt), target);
        return followService.getFollowing(target.getId());
    }

    private void requireVisible(User viewer, User target) {
        if (!followService.canViewFollowLists(viewer.getId(), target)) {
            throw new PrivateAccountException();
        }
    }

    private User currentUser(Jwt jwt) {
        return userService.getOrProvisionByCognitoSub(jwt);
    }
}
