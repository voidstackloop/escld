package com.escld.backend.controllers;

import java.util.UUID;

import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.escld.backend.dto.LikeResponse;
import com.escld.backend.entities.Post;
import com.escld.backend.entities.User;
import com.escld.backend.exceptions.PrivateAccountException;
import com.escld.backend.hide.HideStore;
import com.escld.backend.services.FollowService;
import com.escld.backend.services.LikeService;
import com.escld.backend.services.PostService;
import com.escld.backend.services.UserService;

import lombok.RequiredArgsConstructor;

@RestController
@RequestMapping("/api/v1")
@RequiredArgsConstructor
public class LikeController {

    private final LikeService likeService;
    private final HideStore hideStore;
    private final PostService postService;
    private final UserService userService;
    private final FollowService followService;

    @PostMapping("/posts/{postId}/like")
    public LikeResponse like(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID postId) {
        User viewer = currentUser(jwt);
        requireVisible(viewer, postAuthor(postId));
        return likeService.like(postId, viewer.getId());
    }

    @DeleteMapping("/posts/{postId}/like")
    public LikeResponse unlike(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID postId) {
        User viewer = currentUser(jwt);
        requireVisible(viewer, postAuthor(postId));
        return likeService.unlike(postId, viewer.getId());
    }

    /**
     * "Not interested" — a purely private decision with no effect on
     * anyone's counters or visibility to others, so (unlike like/unlike
     * above) this deliberately skips the follow-visibility check: hiding a
     * post you technically can't otherwise see is harmless, and the
     * feed-filtering effect (FeedServiceImpl#getFeed) only ever applies to
     * the viewer's own feed regardless.
     */
    @PostMapping("/posts/{postId}/hide")
    public void hide(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID postId) {
        hideStore.hide(currentUser(jwt).getId(), postId);
    }

    @DeleteMapping("/posts/{postId}/hide")
    public void unhide(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID postId) {
        hideStore.unhide(currentUser(jwt).getId(), postId);
    }

    private User postAuthor(UUID postId) {
        Post post = postService.getById(postId);
        return userService.getById(post.getUserId());
    }

    private void requireVisible(User viewer, User author) {
        if (!followService.canViewFollowLists(viewer.getId(), author)) {
            throw new PrivateAccountException();
        }
    }

    private User currentUser(Jwt jwt) {
        return userService.getOrProvisionByCognitoSub(jwt);
    }
}
